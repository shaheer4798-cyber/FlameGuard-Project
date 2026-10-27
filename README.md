# FlameGuard AI — Fire & Smoke Detection

A college-project web dashboard built with HTML, CSS and JavaScript. It monitors a live webcam feed, or a single uploaded image, and uses a pre-trained AI object-detection model to spot fire and smoke and raise an early warning.

## Features

- Live webcam monitoring (browser permission required)
- Image analysis with drag & drop, paste, preview, and boxes drawn on the image
- Confidence scores for every detection, with a per-image result summary
- Adjustable confidence threshold and scan interval on a separate Settings page (shared by both detection pages)
- Potential fire/smoke warning state and automatic fire alarm sound (Howler.js): continuous for live camera, plays twice for uploaded images
- Three pages with a shared navbar: **Live Monitoring** (`index.html`), **Image Analysis** (`image.html`) and **Settings** (`settings.html`)
- Status panel, current assessment, and detection history with alert statistics on both detection pages; history, counters and settings are saved in the browser's localStorage so both pages show the same data
- Responsive dark dashboard

## Files

- `index.html` — Live Monitoring page (navbar, full-width camera, assessment + status panel, history with alert statistics, footer)
- `image.html` — Image Analysis page (navbar, full-width upload panel, result + status panel, history with alert statistics, footer)
- `login.html` / `signup.html` — Login and Sign up pages (email + password, and Google sign-in)
- `firebaseConfiguration.js` — Firebase app setup (exports `auth` and `db`)
- `auth.js` — Firebase login / sign up / Google / password reset logic (ES module)
- `navauth.js` — navbar login state on every page, the **login gate** for the detection pages, and saving alerts to Firestore (ES module)
- `emailConfiguration.js` — your EmailJS keys for email alerts (see *Email alerts* below)
- `settings.html` — Settings page (confidence threshold and scan interval, saved in localStorage)
- `style.css` — responsive dashboard styling (shared)
- `common.js` — shared code: detection request, alarm sound, history/stats saved in localStorage
- `live.js` — webcam handling, live detection, drawing and alerts
- `image.js` — image upload, detection and result display
- `alarm.wav` — fire alarm sound played on alerts (via Howler.js)

## Requirements

- A modern browser (Chrome or Edge recommended)
- Webcam (for live monitoring)
- Internet connection
- Local web server (camera access is usually blocked on ordinary `file://` pages)

## Setup on Windows

1. Extract the ZIP file to a folder.
2. Open the folder in Visual Studio Code.
3. Install the **Live Server** extension if you do not already have it.
4. Right-click `index.html` and choose **Open with Live Server**.
5. Click **Start monitoring** and allow webcam permission, or open the **Image Analysis** page from the navbar and upload an image.
6. Optionally adjust the confidence threshold and scan interval on the **Settings** page. Use **Stop** to turn off the webcam.

Alternative local server if Python is installed: open a terminal in the extracted folder and run:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## How detection works

1. The webcam (or an uploaded image) provides a frame.
2. JavaScript converts the frame to JPEG/base64 and sends it to the cloud-hosted detection model.
3. The model predicts object classes, bounding boxes and confidence scores.
4. JavaScript filters predictions by the selected confidence threshold.
5. The dashboard draws bounding boxes, updates the status, and logs fire/smoke alerts.

For live video, an alert needs at least 75% confidence in 2 of the last 3 scans to reduce false alarms from lights and reflections. For a single uploaded image, the fire/smoke result must reach at least 85% confidence to raise a warning.

## Important limitations

- **Not a certified fire alarm.** Never use this project to protect people, property, or replace approved detectors/emergency procedures.
- **False positives and missed detections are possible.** Results depend on the model's training data, camera angle, lighting, distance, smoke density, image quality, and the confidence threshold.
- **Cloud inference.** Sampled camera frames and uploaded images are sent to a hosted detection service. Do not use the system where video privacy is a concern.
- **Network required.** Detection stops if the internet or the hosted service is unavailable.
- **Camera security.** Webcam access normally requires `localhost` or HTTPS and user permission.
- **Test responsibly.** Do not light a fire or create smoke to test. Use existing safe images or controlled classroom material.

## Troubleshooting

- **Camera button does nothing:** serve the page through Live Server/localhost; check browser camera permission.
- **"Analysis error" / "Service unavailable":** check your internet connection and the browser console, then try again.
- **No detections:** the image may contain no recognizable fire/smoke, the confidence threshold may be too high, or the model may not generalize to your scene.
- **Slow performance:** increase the scan interval to 4 seconds and close other camera-heavy tabs.
- **Image will not load:** use a JPG, PNG or WebP file under 10 MB.


## Firebase login (Authentication + Firestore)

Because `auth.js`, `navauth.js` and `firebaseConfiguration.js` are ES modules, the site must be opened through a web server
(Live Server or `python -m http.server`) — not by double-clicking the HTML files.

In the Firebase console make sure that:

1. **Authentication → Sign-in method**: *Email/Password* and *Google* are both enabled.
2. **Authentication → Settings → Authorized domains** contains the domain you use. `localhost` is there by default;
   if Live Server opens `127.0.0.1`, either browse to `http://localhost:5500` instead or add `127.0.0.1`.
3. **Firestore Database** exists. Each user gets a document in `users/{uid}` (name, email, photoURL, provider, createdAt, lastLoginAt).
   Suggested security rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
      // fire/smoke alerts saved by the app (with location)
      match /alerts/{alertId} {
        allow read, create: if request.auth != null && request.auth.uid == uid;
      }
    }
  }
}
```

If the Firestore write is blocked by rules, login still works (the error is only logged in the browser console).

## Theme

The interface uses a light theme: white surfaces, a "flame" orange accent and "smoke" slate text. The camera area stays dark so video is easy to see.
Colors are CSS variables at the top of `style.css` (`:root`), so they are easy to change.

## Detection accuracy

- **Image analysis (High accuracy mode, default):** the uploaded image is re-drawn on a canvas (fixes phone-photo rotation, limits size to 1280 px) and analyzed twice — normal and mirrored. Boxes found by both checks are merged; a box found by only one check is scaled down, which filters one-off mistakes. Switch to *Standard* on the Settings page for a single, faster check.
- **Live camera:** frames are sent at higher quality (960 px, JPEG 85%). Fire and smoke are confirmed **separately** — each class must appear strongly in 2 of the last 3 scans — and tiny boxes (under 0.2% of the frame) are ignored when raising the alarm.
- **Fire vs smoke in history/analytics:** every alert is saved with its own class. If fire and smoke are both present, two entries are logged (one per class), using the strongest prediction of each class.
- The detection model itself is a hosted Roboflow model (`ENGINE.modelId` in `common.js`). If it often confuses fire and smoke, the only real fix is a better-trained model.


## Login required

Live Monitoring and Image Analysis are only available after logging in. Visitors who are not signed in are sent to the login page and come back to the page they wanted afterwards. Logging out on one of these pages sends you back to the login page.
(This is a convenience gate in the browser, not server-side security.)

## Location and alerts

When Live Monitoring starts, the browser asks for location permission (works on `localhost` or HTTPS). While monitoring, the newest position is kept.
When fire or smoke is confirmed, the alert is saved in the history **with the location** (a Google Maps link), and also in Firestore under `users/{uid}/alerts`.
If permission is denied, the alert is still saved and emailed, just without a location.

## Email alerts

Emails are sent straight from the browser with [EmailJS](https://www.emailjs.com) (free plan: 200 emails/month), so no server is needed.

1. Create an EmailJS account and go to **Email Services → Add New Service** (e.g. Gmail). Copy the **Service ID**.
2. Go to **Email Templates → Create New Template** and set:
   - **To Email:** `{{to_email}}`
   - **Subject:** `{{subject}}`
   - **Content:** `{{message}}`  (other available variables: `{{detected}}`, `{{confidence}}`, `{{source}}`, `{{time}}`, `{{location}}`, `{{map_link}}`, `{{account}}`)

   Save it and copy the **Template ID**.
3. Open **Account → General** and copy the **Public Key**.
4. Paste the three values into `emailConfiguration.js`.
5. On the **Settings** page choose the alert email address (default `shaheer4798@gmail.com`) and press **Send test email**.

Notes: the same type of alert (fire / smoke) is emailed at most once every 2 minutes. Uploaded-image detections are emailed too (without location). In the EmailJS dashboard you can restrict which websites may use your key.
