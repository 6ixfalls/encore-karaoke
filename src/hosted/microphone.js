// Keep the capture request in the button's activation; do not await a permission
// query first. Browsers retain the choice and may deny without another prompt.
export async function requestMicrophone(autoGainControl = true) {
  if (globalThis.isSecureContext === false)
    throw new Error("Microphone access requires a trusted HTTPS connection. Open EnMoku at its HTTPS address.");
  const policy = globalThis.document?.permissionsPolicy || globalThis.document?.featurePolicy;
  if (policy?.allowsFeature && !policy.allowsFeature("microphone"))
    throw new Error("This page's Permissions-Policy blocks the microphone. The server or reverse proxy must allow microphone=(self). Open EnMoku directly in your browser if it is embedded in another app.");
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Microphone capture is unavailable. Open EnMoku directly in a browser using trusted HTTPS.");
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl }, video: false,
    });
  } catch (error) {
    let message;
    switch (error.name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        message = "Microphone access is blocked. Allow this site in your browser's Site settings → Microphone, and allow your browser to use the microphone in your phone's Settings → Apps → Permissions. Reload this page, then tap Enable microphone again.";
        break;
      case "SecurityError":
        message = "Microphone capture is disabled by your browser or device policy. Check the browser's microphone permissions and open EnMoku directly over trusted HTTPS.";
        break;
      case "NotFoundError":
        message = "No microphone was found. Connect or enable a microphone, then try again.";
        break;
      case "NotReadableError":
      case "AbortError":
        message = "The microphone could not start. Check the device's Microphone access switch and close other apps using the microphone, then try again.";
        break;
      default: throw error;
    }
    throw new Error(message, { cause: error });
  }
}
