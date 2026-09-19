package com.mavryn.app;

import android.app.Activity;
import android.os.Bundle;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.Manifest;
import android.content.Intent;
import android.provider.Settings;
import android.webkit.ValueCallback;
import android.graphics.Color;
import android.net.Uri;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.app.AlertDialog;

public class MainActivity extends Activity {
    private static final int PERM_REQ = 44;
    private static final int FILE_REQ = 45;
    private ValueCallback<Uri[]> fileCallback;
    private static final String PREFS = "mavryn_settings";
    private static final String KEY_URL = "url";
    private WebView webView;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        openConfiguredApp();
    }

    private void openConfiguredApp() {
        requestRuntimePermissions();
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = sp.getString(KEY_URL, "");
        if (url == null || url.trim().isEmpty()) {
            final EditText input = new EditText(this);
            input.setHint("https://your-mavryn.onrender.com");
            input.setSingleLine(true);
            input.setTextColor(Color.DKGRAY);
            new AlertDialog.Builder(this)
                    .setTitle("Connect Mavryn")
                    .setMessage("Paste the HTTPS URL of your deployed Mavryn app. This is saved on this device.")
                    .setView(input)
                    .setCancelable(false)
                    .setPositiveButton("Open", (d, w) -> {
                        String value = input.getText().toString().trim();
                        if (!value.startsWith("https://")) value = "https://" + value;
                        sp.edit().putString(KEY_URL, value).apply();
                        load(value);
                    }).show();
        } else load(url);
    }

    private void load(String url) {
        webView = new WebView(this);
        setContentView(webView, new ViewGroup.LayoutParams(-1, -1));
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = params.createIntent();
                try { startActivityForResult(intent, FILE_REQ); } catch (Exception e) { fileCallback = null; return false; }
                return true;
            }
        });
        webView.loadUrl(url);
    }

    private void requestRuntimePermissions() {
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            java.util.ArrayList<String> need = new java.util.ArrayList<>();
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.CAMERA);
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO);
            if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), PERM_REQ);
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_REQ && fileCallback != null) {
            Uri[] result = (resultCode == RESULT_OK && data != null) ? new Uri[]{data.getData()} : null;
            fileCallback.onReceiveValue(result); fileCallback = null;
        }
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }
}
