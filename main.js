import './style.css';

import firebase from 'firebase/app';
import 'firebase/firestore';
import firebaseConfig from './creds.js';


if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const firestore = firebase.firestore();

const servers = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  ],
  iceCandidatePoolSize: 10,
};



function getParam(name, fallback) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name) || fallback;
}


const CONFIG = {
  SELF_CALL_ID: getParam('self', 'deviceA'),     // default fallback
  REMOTE_CALL_ID: getParam('remote', 'deviceB'), // default fallback
};
/**
 * CONFIG (fixed IDs)
 * - SELF_CALL_ID: your own fixed signaling doc ID (your “online” presence)
 * - REMOTE_CALL_ID: the other side’s signaling doc ID you want to connect to
 
const CONFIG = {
  SELF_CALL_ID: 'deviceA',   // <-- set this
  REMOTE_CALL_ID: 'deviceB', // <-- set this
};
*/

// videos
const webcamVideo = document.getElementById('webcamVideo');
const remoteVideo = document.getElementById('remoteVideo');

// time
const webcamTime = document.getElementById('webcamTime');
const remoteTime = document.getElementById('remoteTime');

// buttons
const swapButton = document.getElementById('swapButton');
const muteButton = document.getElementById('muteButton');
const silentButton = document.getElementById('silentButton');
const cameraButton = document.getElementById('cameraButton');

swapButton.addEventListener('click', swapScreens);
muteButton.addEventListener('click', muteVideo);
silentButton.addEventListener('click', silentVideo);
cameraButton.addEventListener('click', endCamera);


let swapped = false;
let isMuted = false;
let isSilenced = false;
let isCameraOff = false;

let isConnected = false;

function swapScreens() {
  if (!swapped) {
    webcamVideo.classList.add('largeVideo');
    remoteVideo.classList.add('smallVideo');

    webcamVideo.classList.remove('smallVideo');
    remoteVideo.classList.remove('largeVideo');

    webcamTime.classList.add('largeTime');
    remoteTime.classList.add('smallTime');

    webcamTime.classList.remove('smallTime');
    remoteTime.classList.remove('largeTime'); 
    
  }
  else {
    webcamVideo.classList.add('smallVideo');
    remoteVideo.classList.add('largeVideo');

    webcamVideo.classList.remove('largeVideo');
    remoteVideo.classList.remove('smallVideo');

    webcamTime.classList.add('smallTime');
    remoteTime.classList.add('largeTime');

    webcamTime.classList.remove('largeTime');
    remoteTime.classList.remove('smallTime'); 
  }
  swapped = !swapped;
}

function muteVideo() {
   if (!isMuted) {
    if (!localStream) return;
    let audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = false;
    muteButton.children[0].src = "icons/mic_off.svg";
  }
  else {
    if (!localStream) return;
    let audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = true;
   muteButton.children[0].src = "icons/mic.svg";
  }
  isMuted = !isMuted;
}

function silentVideo() {
   if (!isSilenced) {
    remoteVideo.muted = true;
    silentButton.children[0].src = "icons/volume_off.svg";
  }
  else {
   remoteVideo.muted = false;
   silentButton.children[0].src = "icons/volume.svg";
  }
  isSilenced = !isSilenced;
}

function endCamera(){
  if (!isCameraOff) {
    if (!localStream) return;
    let videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = false;
    cameraButton.children[0].src = "icons/video_off.svg";
  }
  else {
    if (!localStream) return;
    let videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = true;
   cameraButton.children[0].src = "icons/video.svg";
  }
  isCameraOff = !isCameraOff;
}






// Global state
let pc = null;
let localStream = null;
let remoteStream = null;

// A per-page-load session id to ignore stale ICE candidates from old runs
const sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function createPeerConnection() {
  pc = new RTCPeerConnection(servers);

  // Remote media stream
  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  // Pull remote tracks
  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => remoteStream.addTrack(track));
  };

  // Push local tracks
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  return pc;
}

// 1) Start webcam immediately on page load
async function startWebcam() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

  // 2) Do NOT output local stream audio on the website
  webcamVideo.srcObject = localStream;
  webcamVideo.muted = true;          // prevent echo/feedback
  webcamVideo.volume = 0;            // extra safety
  webcamVideo.playsInline = true;
  remoteVideo.playsInline = true;
}

function withSession(candidateJson) {
  return { ...candidateJson, sessionId };
}

function isSameSession(data) {
  return data && data.sessionId === sessionId;
}

/**
 * Answer a call that exists at REMOTE_CALL_ID (if it has an offer)
 */
async function answerRemoteIfOnline() {
  const callDoc = firestore.collection('calls').doc(CONFIG.REMOTE_CALL_ID);
  const offerCandidates = callDoc.collection('offerCandidates');
  const answerCandidates = callDoc.collection('answerCandidates');

  const snap = await callDoc.get();
  const callData = snap.data();

  // 4) Check if the remote ID is "online" (has an offer)
  if (!callData?.offer) return false;

  // Fresh PC for this attempt
  createPeerConnection();

  // ICE -> write to remote doc's answerCandidates
  pc.onicecandidate = (event) => {
    event.candidate && answerCandidates.add(withSession(event.candidate.toJSON()));
  };

  // Set remote offer
  await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));

  // Create + set local answer
  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);

  await callDoc.update({
    answer: { type: answerDescription.type, sdp: answerDescription.sdp },
    answerSessionId: sessionId,
  });

  // Add remote offer candidates (only current session if present)
  offerCandidates.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type !== 'added') return;
      const data = change.doc.data();

      // If the offer side also tags sessionId, respect it; otherwise accept (for compatibility)
      if (data.sessionId && data.sessionId !== callData.offerSessionId) return;

      pc.addIceCandidate(new RTCIceCandidate(data)).catch(console.error);
    });
  });

  return true;
}

/**
 * Create/publish an offer at SELF_CALL_ID and wait for an answer
 */
async function createOfferAndWait() {
  const callDoc = firestore.collection('calls').doc(CONFIG.SELF_CALL_ID);
  const offerCandidates = callDoc.collection('offerCandidates');
  const answerCandidates = callDoc.collection('answerCandidates');

  createPeerConnection();

  // ICE -> write to own offerCandidates
  pc.onicecandidate = (event) => {
    event.candidate && offerCandidates.add(withSession(event.candidate.toJSON()));
  };

  // Create offer
  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  await callDoc.set({
    offer: { type: offerDescription.type, sdp: offerDescription.sdp },
    offerSessionId: sessionId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  // Listen for answer
  callDoc.onSnapshot((snapshot) => {
    const data = snapshot.data();
    if (!data?.answer) return;

    // Respect answer session (if present)
    if (data.answerSessionId && data.answerSessionId !== sessionId) return;

    if (!pc.currentRemoteDescription) {
      pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(console.error);
    }
  });

  // Add answer candidates
  answerCandidates.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type !== 'added') return;
      const data = change.doc.data();

      if (data.sessionId && data.sessionId !== sessionId) return;

      pc.addIceCandidate(new RTCIceCandidate(data)).catch(console.error);
    });
  });
}





/**
 * Main: start webcam, try answering remote if online; otherwise publish own offer.
 */
async function init() {
  await startWebcam();

  console.log('WebRTC config:', CONFIG);

  // 4) If remote is online => connect to it
  const connectedToRemote = await answerRemoteIfOnline();
  if (connectedToRemote) return;



  // 3) Always use same localstream id (SELF_CALL_ID) to publish our offer
  await createOfferAndWait();
}

// Start immediately when the page loads
window.addEventListener('load', () => {
  init().catch(console.error);
});
