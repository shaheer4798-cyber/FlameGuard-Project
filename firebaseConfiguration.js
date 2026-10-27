// Firebase setup (Authentication + Firestore). Imported by auth.js and navauth.js.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyALxW6emIYj6wd4h8nW-SvZheXxZjVMFCA",
  authDomain: "fire-smoke-detection-project.firebaseapp.com",
  projectId: "fire-smoke-detection-project",
  storageBucket: "fire-smoke-detection-project.firebasestorage.app",
  messagingSenderId: "495073673871",
  appId: "1:495073673871:web:2b4a716a279e6a311726fa"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
