/* ==========================================================================
   FlameGuard AI — navbar login state (loaded on every page)
   Logged out: shows "Log in" / "Sign up".  Logged in: shows name + "Log out".
   ========================================================================== */
import { auth, db } from "./firebaseConfiguration.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

const box = document.querySelector(".auth-buttons");
const guestMarkup = box ? box.innerHTML : "";   // original Log in / Sign up buttons

function buildUserChip(user) {
  const name = (user.displayName || user.email || "Account").trim();

  const chip = document.createElement("span");
  chip.className = "user-chip";
  chip.title = user.email || name;

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  if (user.photoURL) {
    const img = document.createElement("img");
    img.src = user.photoURL;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => { img.remove(); avatar.textContent = name.charAt(0).toUpperCase(); });
    avatar.appendChild(img);
  } else {
    avatar.textContent = name.charAt(0).toUpperCase();
  }

  const label = document.createElement("span");
  label.className = "user-name";
  label.textContent = name.split(" ")[0];     // textContent: safe against HTML in names

  chip.append(avatar, label);

  const logout = document.createElement("button");
  logout.type = "button";
  logout.className = "btn btn-secondary btn-nav";
  logout.textContent = "Log out";
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    try { await signOut(auth); }
    catch (error) { console.warn("Sign out failed:", error); logout.disabled = false; }
  });

  return [chip, logout];
}

// Pages marked <body data-require-auth> (Live Monitoring, Image Analysis) need a logged-in user.
const requireAuth = document.body.hasAttribute("data-require-auth");

onAuthStateChanged(auth, (user) => {
  // Let the other scripts (email alerts) know who is signed in.
  window.FG_USER = user ? { uid: user.uid, name: user.displayName || "", email: user.email || "" } : null;

  if (box) {
    if (user) box.replaceChildren(...buildUserChip(user));
    else box.innerHTML = guestMarkup;
  }

  if (requireAuth) {
    if (!user) {
      // Not logged in (or just logged out): go to the login page, then come back here.
      const page = window.location.pathname.split("/").pop() || "index.html";
      window.location.replace(`login.html?next=${encodeURIComponent(page)}`);
      return;
    }
    document.documentElement.classList.remove("guard-pending", "guard-slow");
  }
  document.body.classList.add("auth-ready");
});

// Every fire/smoke alert (from common.js) is also saved in Firestore: users/{uid}/alerts
window.addEventListener("fg-alert", async (event) => {
  const user = auth.currentUser;
  if (!user) return;
  const a = event.detail || {};
  try {
    await addDoc(collection(db, "users", user.uid, "alerts"), {
      label: a.label || "",
      confidence: Number(a.confidence) || 0,
      source: a.source || "live",
      location: a.location ? { lat: a.location.lat, lng: a.location.lng, accuracy: a.location.accuracy || 0, address: a.location.address || "" } : null,
      clientTime: a.ts || Date.now(),
      createdAt: serverTimestamp()
    });
  } catch (error) {
    console.warn("Could not save the alert to Firestore:", error);
  }
});
