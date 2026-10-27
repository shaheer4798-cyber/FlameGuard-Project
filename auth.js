/* ==========================================================================
   FlameGuard AI — Login / Sign up (Firebase Authentication + Firestore)
   Works with: email + password, and Google sign-in.
   ========================================================================== */
import { auth, db } from "./firebaseConfiguration.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider,
  updateProfile, sendPasswordResetEmail,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

// After logging in, go back to the page the user wanted (?next=image.html), otherwise the home page.
const HOME_PAGE = (() => {
  const wanted = new URLSearchParams(window.location.search).get("next");
  return ["index.html", "image.html", "settings.html"].includes(wanted) ? wanted : "index.html";
})();
const $ = (id) => document.getElementById(id);

/* ---------- UI helpers ---------- */
function showMessage(text, type = "error") {
  const box = $("authMessage");
  if (!box) return;
  box.textContent = text;
  box.className = `auth-message ${type}`;
  box.hidden = false;
}
function clearMessage() {
  const box = $("authMessage");
  if (box) { box.hidden = true; box.textContent = ""; }
}
function setBusyUI(busy) {
  document.querySelectorAll("#loginSubmit, #signupSubmit, #googleBtn").forEach((btn) => { btn.disabled = busy; });
  const submit = $("loginSubmit") || $("signupSubmit");
  if (submit) {
    if (!submit.dataset.label) submit.dataset.label = submit.textContent;
    submit.textContent = busy ? "Please wait…" : submit.dataset.label;
  }
}

// Turn Firebase error codes into friendly sentences.
function friendlyError(error) {
  switch (error && error.code) {
    case "auth/invalid-email": return "That email address doesn’t look right.";
    case "auth/missing-password": return "Please enter your password.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found": return "Incorrect email or password.";
    case "auth/user-disabled": return "This account has been disabled.";
    case "auth/email-already-in-use": return "An account with this email already exists. Try logging in instead.";
    case "auth/weak-password": return "Password is too weak. Use at least 6 characters.";
    case "auth/too-many-requests": return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed": return "Network error. Check your internet connection and try again.";
    case "auth/operation-not-allowed": return "This sign-in method is not enabled in the Firebase console (Authentication → Sign-in method).";
    case "auth/unauthorized-domain": return "This domain is not authorized in Firebase (Authentication → Settings → Authorized domains). Use localhost or add this domain.";
    case "auth/account-exists-with-different-credential": return "An account already exists with this email using a different sign-in method.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request": return null;           // user closed the popup: stay quiet
    default: return (error && error.message) ? error.message : "Something went wrong. Please try again.";
  }
}
function handleError(error) {
  console.warn("Auth error:", error);
  const text = friendlyError(error);
  if (text) showMessage(text, "error");
}

/* ---------- Firestore: save a profile document for each user ---------- */
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}
async function saveUserProfile(user, provider, nameOverride) {
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    const data = {
      name: nameOverride || user.displayName || "",
      email: user.email || "",
      photoURL: user.photoURL || "",
      provider,
      lastLoginAt: serverTimestamp()
    };
    if (!snap.exists()) data.createdAt = serverTimestamp();
    await setDoc(ref, data, { merge: true });
  } catch (error) {
    // Never block login if Firestore rules/network reject this write.
    console.warn("Could not save user profile to Firestore:", error);
  }
}

/* ---------- Redirect handling ---------- */
let busy = true;               // true while a sign-in is in progress (prevents early redirects)
let currentUser = null;
function goHome() { window.location.href = HOME_PAGE; }
function maybeRedirect() {
  if (!busy && currentUser) {
    showMessage("You are already signed in. Redirecting…", "info");
    goHome();
  }
}
onAuthStateChanged(auth, (user) => { currentUser = user; maybeRedirect(); });

// Finish a Google sign-in that used redirect (popup-blocked browsers / some phones).
let handledRedirect = false;
getRedirectResult(auth)
  .then(async (result) => {
    if (result && result.user) {
      handledRedirect = true;
      await withTimeout(saveUserProfile(result.user, "google"), 4000);
      goHome();
    }
  })
  .catch(handleError)
  .finally(() => { if (!handledRedirect) { busy = false; maybeRedirect(); } });

/* ---------- Keep ?next=... when switching between Log in and Sign up ---------- */
const nextParam = new URLSearchParams(window.location.search).get("next");
if (nextParam) {
  document.querySelectorAll(".auth-switch a").forEach((a) => {
    a.href = `${a.getAttribute("href")}?next=${encodeURIComponent(nextParam)}`;
  });
}

/* ---------- Show / hide password ---------- */
document.querySelectorAll(".toggle-password").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.target);
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
});

/* ---------- Login (email + password) ---------- */
const loginForm = $("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessage();
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    if (!email || !password) { showMessage("Please enter your email and password."); return; }

    busy = true; setBusyUI(true);
    try {
      // "Remember me": keep the session after the browser closes; otherwise only for this tab.
      await setPersistence(auth, $("rememberMe").checked ? browserLocalPersistence : browserSessionPersistence);
      const cred = await signInWithEmailAndPassword(auth, email, password);
      await withTimeout(saveUserProfile(cred.user, "password"), 4000);
      goHome();
    } catch (error) {
      busy = false; setBusyUI(false);
      handleError(error);
    }
  });

  $("forgotLink").addEventListener("click", async (event) => {
    event.preventDefault();
    clearMessage();
    const email = $("loginEmail").value.trim();
    if (!email) { showMessage("Type your email address above first, then click “Forgot password?”.", "info"); return; }
    try {
      await sendPasswordResetEmail(auth, email);
      showMessage(`If an account exists for ${email}, a password reset link has been sent.`, "success");
    } catch (error) { handleError(error); }
  });
}

/* ---------- Sign up (email + password) ---------- */
const signupForm = $("signupForm");
if (signupForm) {
  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessage();
    const name = $("signupName").value.trim();
    const email = $("signupEmail").value.trim();
    const password = $("signupPassword").value;
    const confirm = $("signupConfirm").value;

    if (!name || !email || !password || !confirm) { showMessage("Please fill in all fields."); return; }
    if (password.length < 6) { showMessage("Password must be at least 6 characters."); return; }
    if (password !== confirm) { showMessage("Passwords do not match."); return; }
    if (!$("agreeTerms").checked) { showMessage("Please accept the Terms of Service and Privacy Policy."); return; }

    busy = true; setBusyUI(true);
    try {
      await setPersistence(auth, browserLocalPersistence);
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
      await withTimeout(saveUserProfile(cred.user, "password", name), 4000);
      showMessage("Account created! Redirecting…", "success");
      goHome();
    } catch (error) {
      busy = false; setBusyUI(false);
      handleError(error);
    }
  });
}

/* ---------- Google sign-in (login + signup pages) ---------- */
const googleBtn = $("googleBtn");
if (googleBtn) {
  googleBtn.addEventListener("click", async () => {
    clearMessage();
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    busy = true; setBusyUI(true);
    try {
      const remember = $("rememberMe");
      await setPersistence(auth, remember && !remember.checked ? browserSessionPersistence : browserLocalPersistence);
      const cred = await signInWithPopup(auth, provider);
      await withTimeout(saveUserProfile(cred.user, "google"), 4000);
      goHome();
    } catch (error) {
      if (error && (error.code === "auth/popup-blocked" || error.code === "auth/operation-not-supported-in-this-environment")) {
        try { await signInWithRedirect(auth, provider); return; }   // page leaves; result handled on return
        catch (redirectError) { error = redirectError; }
      }
      busy = false; setBusyUI(false);
      handleError(error);
    }
  });
}
