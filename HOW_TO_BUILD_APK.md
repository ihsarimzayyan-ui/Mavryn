# Build the Android APK

1. Install Android Studio and the Android SDK.
2. Open this folder: `android/`.
3. Let Android Studio sync Gradle.
4. Run a debug build or choose **Build → Build APK(s)**.
5. Install the resulting APK on an Android phone.
6. On first launch, enter the HTTPS URL of the deployed Mavryn Render service, for example:
   `https://mavryn-private.onrender.com`
7. The app saves the URL on the device.

The Android wrapper requests CAMERA and RECORD_AUDIO permissions because Mavryn supports WebRTC calls and voice messages. File upload is handled with the WebView file chooser.
