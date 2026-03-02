import { useState, useRef, useEffect, ChangeEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  User, FileText, Camera, Mic, CheckCircle2, 
  AlertCircle, Loader2, ArrowRight, ArrowLeft, 
  Upload, ShieldCheck, ShieldAlert, ShieldX, Download, Fingerprint,
  History, Clock, Shield, User as UserIcon
} from 'lucide-react';
import { GoogleGenAI } from "@google/genai";
import { generateContentWithRetry } from '../../lib/gemini';
import { generateKYCReport } from '../../lib/reportGenerator';
import { cn } from '../../lib/utils';
import { auth, rtdb } from '../../lib/firebase';
import { ref, push, set, onValue, serverTimestamp } from 'firebase/database';
import { useToast } from '../../context/ToastContext';

const getFriendlyErrorMessage = (err: any): string => {
  const msg = err?.message || '';
  if (msg.includes('429') || msg.includes('Quota exceeded') || msg.includes('RESOURCE_EXHAUSTED')) {
    return 'API Rate Limit Exceeded. Please wait a moment and try again.';
  }
  if (msg.includes('API key not valid')) {
    return 'Invalid API Key. Please check your configuration.';
  }
  return msg || 'An unexpected error occurred.';
};

type Step = 'identity' | 'face' | 'voice' | 'result' | 'history';

export default function KYCWorkflow({ user }: { user: any }) {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>('identity');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Data
  const [personalDetails, setPersonalDetails] = useState({ fullName: user.fullName || user.full_name || '', dob: '', address: '' });
  const [aadhaarImage, setAadhaarImage] = useState<string | null>(null);
  const [faceImage, setFaceImage] = useState<string | null>(null);
  const [livenessFrames, setLivenessFrames] = useState<string[]>([]);
  const [livenessStepIndex, setLivenessStepIndex] = useState(-1);
  const [livenessStatus, setLivenessStatus] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  
  // Results
  const [aadhaarResult, setAadhaarResult] = useState<any>(null);
  const [faceResult, setFaceResult] = useState<any>(null);
  const [voiceResult, setVoiceResult] = useState<any>(null);
  const [finalResult, setFinalResult] = useState<any>(null);
  const [permissions, setPermissions] = useState<{ camera: boolean | null, microphone: boolean | null }>({ camera: null, microphone: null });
  const [history, setHistory] = useState<any[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Fetch History
  useEffect(() => {
    if (rtdb && user?.id) {
      const historyRef = ref(rtdb, `kyc_users/${user.id}`);
      const unsubscribe = onValue(historyRef, (snapshot) => {
        const data = snapshot.val();
        if (data) {
          const records = Object.entries(data).map(([id, val]: [string, any]) => ({
            id,
            ...val
          })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          setHistory(records);
        } else {
          setHistory([]);
        }
      }, (err) => {
        console.error("History Fetch Error:", err);
      });
      return () => unsubscribe();
    }
  }, [user?.id]);
  const getAI = () => {
    let apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Gemini API key is not configured in the Secrets panel.");
    // Trim any accidental whitespace or quotes
    apiKey = apiKey.trim().replace(/^["']|["']$/g, '');
    return new GoogleGenAI({ apiKey });
  };

  // --- Permission Handlers ---
  const checkPermissions = async () => {
    try {
      const camStatus = await navigator.permissions.query({ name: 'camera' as any });
      const micStatus = await navigator.permissions.query({ name: 'microphone' as any });
      
      setPermissions({
        camera: camStatus.state === 'granted',
        microphone: micStatus.state === 'granted'
      });

      camStatus.onchange = () => setPermissions(prev => ({ ...prev, camera: camStatus.state === 'granted' }));
      micStatus.onchange = () => setPermissions(prev => ({ ...prev, microphone: micStatus.state === 'granted' }));
    } catch (e) {
      console.warn('Permissions API not fully supported', e);
    }
  };

  useEffect(() => {
    checkPermissions();
  }, []);

  const requestPermissions = async (type: 'camera' | 'microphone') => {
    try {
      if (type === 'camera') {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(t => t.stop());
        setPermissions(prev => ({ ...prev, camera: true }));
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        setPermissions(prev => ({ ...prev, microphone: true }));
      }
      showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} access granted`, 'success');
      setError('');
    } catch (err) {
      const msg = `${type.charAt(0).toUpperCase() + type.slice(1)} access denied. Please enable it in browser settings.`;
      setError(msg);
      showToast(msg, 'error');
    }
  };

  // --- Step Handlers ---

  const handleNext = () => {
    if (step === 'identity') setStep('face');
    else if (step === 'face') {
      setStep('voice');
      setVerificationCode(Math.floor(1000 + Math.random() * 9000).toString());
    }
    else if (step === 'voice') finalizeKYC();
  };

  const handleBack = () => {
    if (step === 'face') setStep('identity');
    else if (step === 'voice') setStep('face');
  };

  // --- Aadhaar Upload ---
  const onAadhaarUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setAadhaarImage(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  const verifyAadhaar = async () => {
    if (!aadhaarImage) return;
    setLoading(true);
    setError('');
    try {
      const ai = getAI();
      const response = await generateContentWithRetry(ai, {
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              { text: `Analyze this Aadhaar card image. Extract the name, Aadhaar number, DOB, and Address. 
              Compare it with the provided details: ${JSON.stringify(personalDetails)}.
              Check for signs of tampering, fake fonts, or inconsistent layouts.
              Return a JSON object with: { name, aadhaarNumber, dob, address, isTampered, confidence, reasoning }.` },
              { inlineData: { mimeType: "image/jpeg", data: aadhaarImage.split(",")[1] } }
            ]
          }
        ],
        config: { responseMimeType: "application/json" }
      });

      let text = response.text || "{}";
      text = text.replace(/```json\n?|```/g, "").trim();
      const data = JSON.parse(text);
      setAadhaarResult(data);
      if (data.address) {
        setPersonalDetails(prev => ({ ...prev, address: data.address }));
      }
      showToast('Aadhaar verified successfully', 'success');
      handleNext();
    } catch (err: any) {
      console.error("Aadhaar Verification Error:", err);
      const msg = getFriendlyErrorMessage(err) || 'Aadhaar verification failed';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  // --- Face Capture ---
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) videoRef.current.srcObject = stream;
      setPermissions(prev => ({ ...prev, camera: true }));
    } catch (err) {
      setError('Camera access denied. Please check your browser settings.');
      setPermissions(prev => ({ ...prev, camera: false }));
    }
  };

  const captureFace = () => {
    if (videoRef.current && canvasRef.current) {
      const context = canvasRef.current.getContext('2d');
      if (context) {
        context.drawImage(videoRef.current, 0, 0, 640, 480);
        const data = canvasRef.current.toDataURL('image/jpeg');
        return data;
      }
    }
    return null;
  };

  const livenessSteps = [
    { id: 'straight', label: 'Look straight into the camera', icon: User },
    { id: 'blink', label: 'Blink your eyes twice', icon: Camera },
    { id: 'smile', label: 'Smile naturally', icon: CheckCircle2 },
    { id: 'turn', label: 'Turn head left and right', icon: ArrowRight },
    { id: 'forward', label: 'Move slightly forward', icon: ArrowRight },
  ];

  const startLivenessSession = async () => {
    await startCamera();
    setLivenessStepIndex(0);
    setLivenessFrames([]);
    setLivenessStatus('Get ready...');
    setCountdown(3);
  };

  useEffect(() => {
    let timer: any;
    if (livenessStepIndex >= 0 && livenessStepIndex < livenessSteps.length) {
      if (countdown > 0) {
        timer = setTimeout(() => setCountdown(prev => prev - 1), 1000);
      } else {
        // Capture frame
        const frame = captureFace();
        if (frame) {
          setLivenessFrames(prev => [...prev, frame]);
          
          const stepId = livenessSteps[livenessStepIndex].id;
          if (stepId === 'blink') setLivenessStatus('Blink captured');
          else if (stepId === 'smile') setLivenessStatus('Expression captured');
          else if (stepId === 'turn') setLivenessStatus('Movement captured');
          else if (stepId === 'forward') setLivenessStatus('Depth captured');
          else setLivenessStatus('Position captured');
          
          if (livenessStepIndex === livenessSteps.length - 1) {
            // Finished all steps
            setTimeout(() => {
              setLivenessStepIndex(-1);
              setLivenessStatus('All frames captured');
              if (videoRef.current && videoRef.current.srcObject) {
                const stream = videoRef.current.srcObject as MediaStream;
                stream.getTracks().forEach(track => track.stop());
              }
            }, 1000);
          } else {
            // Next step
            setTimeout(() => {
              setLivenessStepIndex(prev => prev + 1);
              setCountdown(3);
            }, 1000);
          }
        }
      }
    }
    return () => clearTimeout(timer);
  }, [livenessStepIndex, countdown]);

  const verifyFace = async () => {
    if (livenessFrames.length === 0 || !aadhaarImage) return;
    setLoading(true);
    setError('');
    try {
      const ai = getAI();
      const parts = [
        { inlineData: { mimeType: "image/jpeg", data: aadhaarImage.split(",")[1] } }, // Aadhaar photo for comparison
        ...livenessFrames.map((img: string) => ({
          inlineData: { mimeType: "image/jpeg", data: img.split(",")[1] }
        }))
      ];

      const response = await generateContentWithRetry(ai, {
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              { text: `Analyze the provided images for advanced KYC face liveness, deepfake detection, and identity matching.
              
              Input:
              - Image 1: User's Aadhaar card photo.
              - Images 2-6: A sequence of 5 frames representing a user following these instructions:
                1. Look straight
                2. Blink eyes
                3. Smile
                4. Turn head
                5. Move forward
              
              Rigorous Security Task:
              1. Face Match: Compare the face on the Aadhaar card (Image 1) with the face in the live frames (Images 2-6). Calculate a match score (0-100) based on facial features, geometry, and landmarks.
              2. Liveness Verification: Verify if the user followed each instruction across the frames. Check for micro-movements (blinking, smile, head turn, depth change).
              3. Deepfake Detection: Detect signs of spoofing: 
                * Photo-of-photo: Look for moiré patterns, static textures, or glare.
                * Video replay: Look for screen borders, unnatural reflections, or pixelation.
                * Deepfake/Synthetic: Look for facial artifacts, inconsistent skin texture, unnatural eye movement, lip-sync issues, or blending errors at the edges of the face.
                * Masks: Look for unnatural edges or rigid facial structures.
              
              Return a JSON object with: 
              { 
                isLive: boolean, 
                humanDetected: boolean,
                confidence: number (0-100), 
                riskLevel: "low" | "medium" | "high",
                detectedMovements: { blink: boolean, smile: boolean, headTurn: boolean, depthChange: boolean },
                matchScore: number (0-100),
                reasoning: string,
                explanation: string (detailed summary for user)
              }.` },
              ...parts
            ]
          }
        ],
        config: { responseMimeType: "application/json" }
      });

      let text = response.text || "{}";
      text = text.replace(/```json\n?|```/g, "").trim();
      const data = JSON.parse(text);
      setFaceResult(data);
      setFaceImage(livenessFrames[0]);
      showToast('Face verification complete', 'success');
    } catch (err: any) {
      console.error("Face Verification Error:", err);
      const msg = getFriendlyErrorMessage(err) || 'Face verification failed';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  // --- Voice Verification ---
  const startVoiceRecording = async () => {
    setError('');
    setVoiceTranscript('');
    setAudioBase64(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setPermissions(prev => ({ ...prev, microphone: true }));
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          setAudioBase64(base64);
        };
        reader.readAsDataURL(audioBlob);
        
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
        setIsRecording(false);
      };

      // Also try SpeechRecognition for live feedback, but don't rely on it for the final result
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.continuous = false;
        recognition.interimResults = true;

        recognition.onresult = (event: any) => {
          const transcript = Array.from(event.results)
            .map((result: any) => result[0].transcript)
            .join('');
          setVoiceTranscript(transcript);
        };

        recognition.onerror = (event: any) => {
          console.warn('Speech recognition non-fatal error:', event.error);
          // We don't set global error here because we have the raw audio backup
          if (event.error === 'network') {
            setVoiceTranscript('(Network error: Live transcript unavailable, but audio is being recorded)');
          }
        };

        recognition.start();
      }

      mediaRecorder.start();
      setIsRecording(true);

      // Automatically stop after 5 seconds
      setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, 5000);

    } catch (err: any) {
      console.error('Microphone access error:', err);
      setError('Could not access microphone. Please check permissions.');
      setPermissions(prev => ({ ...prev, microphone: false }));
      setIsRecording(false);
    }
  };

  const verifyVoice = async () => {
    if (!audioBase64) {
      setError('No audio recorded. Please try again.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const ai = getAI();
      const expectedText = `My verification code is ${verificationCode}`;
      
      const response = await generateContentWithRetry(ai, {
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              { text: `Analyze the provided audio for KYC voice liveness and deepfake detection.
              Expected phrase to be spoken: "${expectedText}"
              The user MUST say the specific code: ${verificationCode}.
              
              Rigorous Security Task:
              1. Transcription & Code Match: Transcribe the audio. Does it contain the correct 4-digit code?
              2. Deepfake Detection: Check for robotic cadence, frequency artifacts, unnatural breathing, or signs of AI voice cloning (e.g., lack of emotional inflection, consistent background noise that sounds synthetic).
              3. Liveness Verification: Evaluate if the voice sounds like a live human in a real-world environment (look for natural mouth sounds, slight background variance, and human-like prosody).
              4. Replay Attack Detection: Check for "room-within-a-room" acoustics or screen-playback artifacts.
              
              Return a JSON object with: { 
                matchesText: boolean, 
                codeVerified: boolean,
                isNatural: boolean, 
                riskLevel: number (0-100), 
                reasoning: string,
                transcript: string,
                confidence: number (0-100)
              }.` },
              { inlineData: { mimeType: "audio/webm", data: audioBase64 } }
            ]
          }
        ],
        config: { responseMimeType: "application/json" }
      });

      let text = response.text || "{}";
      text = text.replace(/```json\n?|```/g, "").trim();
      const data = JSON.parse(text);
      if (data.transcript) setVoiceTranscript(data.transcript);
      setVoiceResult(data);
      showToast('Voice analysis complete', 'success');
      await finalizeKYC(data);
    } catch (err: any) {
      console.error("Voice Verification Error:", err);
      const msg = getFriendlyErrorMessage(err) || 'Voice verification failed';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const finalizeKYC = async (vResult?: any) => {
    setLoading(true);
    setError('');
    try {
      const ai = getAI();
      const currentVoiceResult = vResult || voiceResult;
      
      const response = await generateContentWithRetry(ai, {
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              { text: `Finalize KYC decision based on these components:
              Aadhaar Analysis: ${JSON.stringify(aadhaarResult)}
              Face Liveness Analysis: ${JSON.stringify(faceResult)}
              Voice Analysis: ${JSON.stringify(currentVoiceResult)}
              
              Generate a final decision (verified, suspicious, fake), a total risk score (0-100), a confidence score, and a detailed explanation.
              Return as JSON: { decision, riskScore, confidenceScore, explanation }.` }
            ]
          }
        ],
        config: { responseMimeType: "application/json" }
      });

      let text = response.text || "{}";
      text = text.replace(/```json\n?|```/g, "").trim();
      const final = JSON.parse(text);
      if (final.decision) {
        final.decision = final.decision.toLowerCase();
      }
      
      // Save to Realtime Database
      if (rtdb) {
        try {
          const kycData = {
            userId: user.id || 'unknown',
            name: personalDetails.fullName || 'unknown',
            email: user.email || 'unknown',
            verificationStatus: final.decision === 'verified' ? 'Approved' : 'Rejected',
            riskScore: final.riskScore ?? 0,
            confidenceScore: final.confidenceScore ?? 0,
            riskLevel: (final.riskScore ?? 0) > 70 ? 'High' : (final.riskScore ?? 0) > 30 ? 'Medium' : 'Low',
            explanation: final.explanation,
            timestamp: serverTimestamp(),
            createdAt: new Date().toISOString()
          };
          
          const kycRef = ref(rtdb, `kyc_users/${user.id || 'unknown'}`);
          const newKycRef = push(kycRef);
          await set(newKycRef, kycData);
        } catch (fbErr) {
          console.warn("Firebase save failed:", fbErr);
          showToast("Failed to sync with Realtime Database", "error");
        }
      }

      // Save to local DB as well (keep existing logic for compatibility)
      const res = await fetch('/api/kyc/finalize', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ 
          aadhaar: aadhaarResult, 
          face: faceResult, 
          voice: currentVoiceResult,
          final: final,
          userId: user.id
        })
      });
      
      if (!res.ok) throw new Error("Failed to save verification results to the server.");
      
      setFinalResult(final);
      showToast('KYC process completed successfully', 'success');
      setStep('result');
    } catch (err: any) {
      console.error("Finalization Error:", err);
      const msg = getFriendlyErrorMessage(err) || 'Finalization failed';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      {/* Progress Bar & Tabs */}
      <div className="flex flex-col gap-8 mb-12">
        <div className="flex items-center justify-center gap-4">
          <button 
            onClick={() => setStep('identity')}
            className={cn(
              "px-6 py-2 rounded-full text-sm font-bold transition-all flex items-center gap-2",
              step !== 'history' ? "bg-emerald-500 text-black" : "bg-app-card border border-app-border opacity-50 hover:opacity-100"
            )}
          >
            <Shield className="w-4 h-4" /> Verification
          </button>
          <button 
            onClick={() => setStep('history')}
            className={cn(
              "px-6 py-2 rounded-full text-sm font-bold transition-all flex items-center gap-2",
              step === 'history' ? "bg-emerald-500 text-black" : "bg-app-card border border-app-border opacity-50 hover:opacity-100"
            )}
          >
            <History className="w-4 h-4" /> History
          </button>
        </div>

        {step !== 'history' && (
          <div className="flex items-center justify-between">
            {(['identity', 'face', 'voice', 'result'] as Step[]).map((s, i) => (
              <div key={s} className="flex items-center flex-1 last:flex-none">
                <div className={cn(
                  "w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all",
                  step === s ? "border-emerald-500 bg-emerald-500/20 text-emerald-500" : 
                  i < ['identity', 'face', 'voice', 'result'].indexOf(step) ? "border-emerald-500 bg-emerald-500 text-black" : "border-app-border opacity-20"
                )}>
                  {i < ['identity', 'face', 'voice', 'result'].indexOf(step) ? <CheckCircle2 className="w-6 h-6" /> : i + 1}
                </div>
                {i < 3 && <div className={cn("h-[2px] flex-1 mx-2", i < ['identity', 'face', 'voice', 'result'].indexOf(step) ? "bg-emerald-500" : "bg-app-border")} />}
              </div>
            ))}
          </div>
        )}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          className="bg-app-card border border-app-border rounded-3xl p-8"
        >
          {step === 'history' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
              <div className="flex items-center gap-4 mb-4">
                <div className="p-3 bg-emerald-500/20 rounded-2xl text-emerald-500">
                  <History className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold">Verification History</h2>
                  <p className="opacity-50 text-sm">Real-time records of your KYC attempts.</p>
                </div>
              </div>

              {history.length === 0 ? (
                <div className="text-center py-20 bg-app-bg/30 rounded-3xl border border-dashed border-app-border">
                  <Clock className="w-12 h-12 opacity-10 mx-auto mb-4" />
                  <p className="opacity-40">No verification records found.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {history.map((record) => (
                    <div key={record.id} className="bg-app-bg/50 border border-app-border p-6 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-emerald-500/30 transition-all">
                      <div className="flex items-center gap-4">
                        <div className={cn(
                          "w-12 h-12 rounded-xl flex items-center justify-center",
                          record.verificationStatus === 'Approved' ? "bg-emerald-500/20 text-emerald-500" : "bg-red-500/20 text-red-500"
                        )}>
                          {record.verificationStatus === 'Approved' ? <ShieldCheck className="w-6 h-6" /> : <ShieldAlert className="w-6 h-6" />}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-bold">{record.verificationStatus}</p>
                            <span className="text-[10px] opacity-40 uppercase tracking-widest">•</span>
                            <p className="text-xs opacity-50">{new Date(record.createdAt).toLocaleDateString()} {new Date(record.createdAt).toLocaleTimeString()}</p>
                          </div>
                          <p className="text-xs opacity-40 mt-1 line-clamp-1">{record.explanation}</p>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-6">
                        <div className="text-right">
                          <p className="text-[10px] uppercase tracking-widest opacity-40 mb-1">Risk Score</p>
                          <p className={cn(
                            "font-mono font-bold",
                            record.riskScore > 70 ? "text-red-500" : record.riskScore > 30 ? "text-yellow-500" : "text-emerald-500"
                          )}>{record.riskScore}%</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] uppercase tracking-widest opacity-40 mb-1">Confidence</p>
                          <p className="font-mono font-bold text-emerald-500">{record.confidenceScore}%</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {step === 'identity' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
              <div className="flex items-center gap-4 mb-8">
                <div className="p-3 bg-emerald-500/20 rounded-2xl text-emerald-500">
                  <Fingerprint className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold">Identity Verification</h2>
                  <p className="opacity-50 text-sm">Provide your personal details and upload your Aadhaar card.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase tracking-wider opacity-40 ml-1">Full Name (as per Aadhaar)</label>
                    <input 
                      type="text" 
                      value={personalDetails.fullName}
                      onChange={(e) => setPersonalDetails({...personalDetails, fullName: e.target.value})}
                      className="w-full bg-app-card border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
                      placeholder="John Doe"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase tracking-wider opacity-40 ml-1">Date of Birth</label>
                    <input 
                      type="date" 
                      value={personalDetails.dob}
                      onChange={(e) => setPersonalDetails({...personalDetails, dob: e.target.value})}
                      className="w-full bg-app-card border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
                    />
                  </div>
                </div>

                <div className="space-y-4">
                  <label className="text-xs font-semibold uppercase tracking-wider opacity-40 ml-1">Aadhaar Card Photo</label>
                  <div 
                    onClick={() => document.getElementById('aadhaar-upload')?.click()}
                    className={cn(
                      "aspect-video border-2 border-dashed rounded-3xl flex flex-col items-center justify-center cursor-pointer transition-all relative overflow-hidden group",
                      aadhaarImage ? "border-emerald-500/50 bg-emerald-500/5" : "border-app-border hover:border-emerald-500/50 hover:bg-emerald-500/5"
                    )}
                  >
                    {aadhaarImage ? (
                      <>
                        <img src={aadhaarImage} alt="Aadhaar" className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                          <p className="text-xs font-bold uppercase tracking-widest">Change Photo</p>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="w-12 h-12 bg-app-bg rounded-2xl flex items-center justify-center mb-4 border border-app-border group-hover:scale-110 transition-transform">
                          <Camera className="w-6 h-6 opacity-40" />
                        </div>
                        <p className="text-sm font-bold mb-1">Upload Aadhaar Front</p>
                        <p className="text-[10px] opacity-40 uppercase tracking-widest">JPG, PNG up to 5MB</p>
                      </>
                    )}
                    <input 
                      id="aadhaar-upload"
                      type="file" 
                      accept="image/*"
                      className="hidden"
                      onChange={onAadhaarUpload}
                    />
                  </div>
                </div>
              </div>

              {aadhaarResult && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-emerald-500/10 border border-emerald-500/20 p-4 rounded-2xl flex items-center gap-3 text-emerald-500 text-sm"
                >
                  <CheckCircle2 className="w-5 h-5" />
                  Aadhaar data extracted successfully: {aadhaarResult.name}
                </motion.div>
              )}

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-2xl flex items-center gap-3 text-red-500 text-sm">
                  <AlertCircle className="w-5 h-5" />
                  {error}
                </div>
              )}

              <div className="pt-6 flex justify-end">
                <button 
                  onClick={aadhaarResult ? handleNext : verifyAadhaar}
                  disabled={!aadhaarImage || !personalDetails.fullName || loading}
                  className="bg-emerald-500 text-black font-bold px-12 py-4 rounded-2xl flex items-center gap-2 hover:bg-emerald-400 disabled:opacity-50 transition-all shadow-lg shadow-emerald-500/20"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                    aadhaarResult ? <>Continue to Face Verification <ArrowRight className="w-5 h-5" /></> : <>Verify Identity <ArrowRight className="w-5 h-5" /></>
                  )}
                </button>
              </div>
            </div>
          )}

          {step === 'face' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-emerald-500/20 rounded-2xl text-emerald-400">
                    <Camera className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-bold">Advanced Face Verification</h2>
                    <p className="opacity-50 text-sm">
                      {faceResult ? 'Verification complete. Review your results below.' : 'Follow the instructions to confirm you are a real person.'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/10 rounded-full border border-emerald-500/20">
                  <div className={cn("w-2 h-2 rounded-full", permissions.camera ? "bg-emerald-500" : "bg-red-500")} />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">
                    {permissions.camera ? 'Camera Ready' : 'Camera Required'}
                  </span>
                </div>
              </div>

              {!permissions.camera && !faceResult && livenessStepIndex === -1 && (
                <div className="bg-emerald-500/5 border border-emerald-500/10 p-8 rounded-3xl text-center space-y-4 animate-in zoom-in-95 duration-300">
                  <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto">
                    <Camera className="w-8 h-8 text-emerald-500" />
                  </div>
                  <h3 className="text-xl font-bold">Camera Access Required</h3>
                  <p className="text-sm opacity-60 max-w-xs mx-auto">We need camera access to perform face liveness verification and deepfake detection.</p>
                  <button 
                    onClick={() => requestPermissions('camera')}
                    className="px-8 py-3 bg-emerald-500 text-black font-bold rounded-2xl hover:bg-emerald-400 transition-all shadow-lg shadow-emerald-500/20"
                  >
                    Grant Camera Permission
                  </button>
                </div>
              )}

              {faceResult ? (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="relative aspect-video bg-app-bg rounded-3xl overflow-hidden border border-app-border">
                      <img src={faceImage || ''} className="w-full h-full object-cover" />
                      <div className="absolute top-4 right-4 bg-emerald-500 text-black text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full">
                        Verified
                      </div>
                    </div>
                    
                    <div className="bg-app-card p-6 rounded-3xl border border-app-border flex flex-col justify-center">
                      <p className="text-xs uppercase tracking-widest opacity-40 mb-4">Liveness Detection Results</p>
                      <div className="grid grid-cols-2 gap-4">
                        {faceResult.detectedMovements && Object.entries(faceResult.detectedMovements).map(([key, value]) => (
                          <div key={key} className="flex items-center gap-3 bg-app-bg/50 p-3 rounded-xl border border-app-border/50">
                            <div className={cn("w-2 h-2 rounded-full", value ? "bg-emerald-500" : "bg-red-500")} />
                            <span className="text-xs capitalize font-medium opacity-80">{key.replace(/([A-Z])/g, ' $1')}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {faceResult.matchScore !== undefined && (
                    <div className="bg-app-card p-6 rounded-3xl border border-app-border">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <p className="text-xs uppercase tracking-widest opacity-40 mb-1">Face Match Score</p>
                          <p className="text-sm opacity-60">Confidence in identity matching</p>
                        </div>
                        <p className={cn(
                          "text-3xl font-bold",
                          faceResult.matchScore > 80 ? "text-emerald-500" : faceResult.matchScore > 50 ? "text-orange-500" : "text-red-500"
                        )}>
                          {faceResult.matchScore}%
                        </p>
                      </div>
                      <div className="w-full bg-app-bg rounded-full h-2 overflow-hidden">
                        <div 
                          className={cn(
                            "h-full transition-all duration-1000",
                            faceResult.matchScore > 80 ? "bg-emerald-500" : faceResult.matchScore > 50 ? "bg-orange-500" : "bg-red-500"
                          )}
                          style={{ width: `${faceResult.matchScore}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="bg-emerald-500/10 border border-emerald-500/20 p-4 rounded-2xl flex items-start gap-3">
                    <ShieldCheck className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
                    <p className="text-sm text-emerald-500/80 leading-relaxed">
                      {faceResult.explanation}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="relative aspect-video bg-app-bg rounded-3xl overflow-hidden border border-app-border">
                  {livenessStepIndex === -1 && livenessFrames.length === 0 ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-app-card/50 backdrop-blur-sm z-20">
                      <ShieldCheck className="w-16 h-16 text-emerald-500 mb-4" />
                      <h3 className="text-xl font-bold mb-2">Ready for Liveness Check?</h3>
                      <p className="text-sm opacity-60 mb-6 text-center max-w-xs">We will guide you through a few simple movements to verify your identity.</p>
                      <button onClick={startLivenessSession} className="bg-emerald-500 text-black px-8 py-3 rounded-2xl font-bold hover:bg-emerald-400 transition-all">
                        Start Verification
                      </button>
                    </div>
                  ) : null}

                  <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
                  
                  {livenessStepIndex >= 0 && (
                    <div className="absolute inset-0 flex flex-col items-center justify-between p-8 z-30 pointer-events-none">
                      <div className="flex flex-col items-center gap-4">
                        <div className="bg-app-card/80 backdrop-blur-md px-6 py-3 rounded-2xl border border-app-border flex items-center gap-3">
                          <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
                          <span className="text-lg font-bold text-app-text">{livenessSteps[livenessStepIndex].label}</span>
                        </div>
                        
                        {countdown > 0 && (
                          <motion.div 
                            key={countdown}
                            initial={{ scale: 1.5, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            className="text-6xl font-black text-emerald-500 drop-shadow-[0_0_15px_rgba(16,185,129,0.5)]"
                          >
                            {countdown}
                          </motion.div>
                        )}
                      </div>
                      
                      <div className="w-full max-w-md bg-app-bg/60 backdrop-blur-sm rounded-full h-2 overflow-hidden border border-app-border/50">
                        <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: `${((livenessStepIndex + 1) / livenessSteps.length) * 100}%` }}
                          className="h-full bg-emerald-500"
                        />
                      </div>
                    </div>
                  )}

                  {livenessStatus && (
                    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40">
                      <div className="bg-emerald-500 text-black text-[10px] font-bold uppercase tracking-widest px-4 py-1 rounded-full shadow-lg">
                        {livenessStatus}
                      </div>
                    </div>
                  )}

                  <div className="absolute inset-0 border-[40px] border-black/40 pointer-events-none">
                    <div className="w-full h-full border-2 border-dashed border-emerald-500/50 rounded-[100px]" />
                  </div>
                  
                  <canvas ref={canvasRef} width={640} height={480} className="hidden" />
                </div>
              )}

              <div className="pt-6 flex justify-between">
                <button 
                  onClick={() => {
                    if (faceResult) setFaceResult(null);
                    else handleBack();
                  }} 
                  className="opacity-50 font-bold px-8 py-3 rounded-xl flex items-center gap-2 hover:opacity-100 transition-all"
                >
                  <ArrowLeft className="w-5 h-5" /> {faceResult ? 'Re-verify' : 'Back'}
                </button>
                <button 
                  onClick={faceResult ? handleNext : verifyFace}
                  disabled={(!faceResult && livenessFrames.length < livenessSteps.length) || loading}
                  className="bg-emerald-500 text-black font-bold px-8 py-3 rounded-xl flex items-center gap-2 hover:bg-emerald-400 disabled:opacity-50 transition-all"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                    faceResult ? <>Continue to Voice <ArrowRight className="w-5 h-5" /></> : <>Complete Face Verification <ArrowRight className="w-5 h-5" /></>
                  )}
                </button>
              </div>
            </div>
          )}

          {step === 'voice' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-orange-500/20 rounded-2xl text-orange-400">
                    <Mic className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-bold">Voice Authentication</h2>
                    <p className="opacity-50 text-sm">Read the sentence below clearly into your microphone.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/10 rounded-full border border-emerald-500/20">
                  <div className={cn("w-2 h-2 rounded-full", permissions.microphone ? "bg-emerald-500" : "bg-red-500")} />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">
                    {permissions.microphone ? 'Mic Ready' : 'Mic Required'}
                  </span>
                </div>
              </div>

              {!permissions.microphone && !isRecording && (
                <div className="bg-orange-500/5 border border-orange-500/10 p-8 rounded-3xl text-center space-y-4 animate-in zoom-in-95 duration-300">
                  <div className="w-16 h-16 bg-orange-500/20 rounded-full flex items-center justify-center mx-auto">
                    <Mic className="w-8 h-8 text-orange-500" />
                  </div>
                  <h3 className="text-xl font-bold">Microphone Access Required</h3>
                  <p className="text-sm opacity-60 max-w-xs mx-auto">We need microphone access to verify your voice and detect AI voice clones.</p>
                  <button 
                    onClick={() => requestPermissions('microphone')}
                    className="px-8 py-3 bg-orange-500 text-black font-bold rounded-2xl hover:bg-orange-400 transition-all shadow-lg shadow-orange-500/20"
                  >
                    Grant Mic Permission
                  </button>
                </div>
              )}

              <div className="bg-app-card border border-app-border rounded-3xl p-8 text-center relative overflow-hidden">
                {isRecording && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute inset-0 bg-emerald-500/5 flex items-center justify-center pointer-events-none"
                  >
                    <div className="flex gap-1">
                      {[0, 1, 2, 3, 4].map((i) => (
                        <motion.div
                          key={i}
                          animate={{ height: [10, 30, 10] }}
                          transition={{ repeat: Infinity, duration: 0.6, delay: i * 0.1 }}
                          className="w-1 bg-emerald-500 rounded-full"
                        />
                      ))}
                    </div>
                  </motion.div>
                )}

                <p className="text-xl font-medium mb-2 opacity-60 relative z-10">
                  Please say clearly:
                </p>
                <p className="text-3xl font-black mb-8 text-emerald-400 relative z-10 tracking-tight">
                  "My verification code is <span className="text-white bg-emerald-500 px-3 py-1 rounded-lg ml-2">{verificationCode}</span>"
                </p>
                
                <div className="flex flex-col items-center gap-4 relative z-10">
                  <button 
                    onClick={startVoiceRecording}
                    disabled={isRecording}
                    className={cn(
                      "w-20 h-20 rounded-full flex items-center justify-center group transition-all relative",
                      isRecording 
                        ? "bg-red-500/20 border border-red-500/30" 
                        : "bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/30"
                    )}
                  >
                    {isRecording ? (
                      <div className="w-4 h-4 bg-red-500 rounded-sm animate-pulse" />
                    ) : (
                      <Mic className="w-8 h-8 text-emerald-500 group-hover:scale-110 transition-transform" />
                    )}
                    
                    {isRecording && (
                      <motion.div 
                        layoutId="ring"
                        className="absolute inset-0 rounded-full border-2 border-red-500"
                        animate={{ scale: [1, 1.2], opacity: [1, 0] }}
                        transition={{ repeat: Infinity, duration: 1 }}
                      />
                    )}
                  </button>
                  <p className="text-xs uppercase tracking-widest opacity-40 font-bold">
                    {isRecording ? 'Recording (5s)...' : audioBase64 ? 'Recording captured' : 'Click to start speaking'}
                  </p>
                </div>

                {voiceTranscript && (
                  <div className="mt-8 p-4 bg-app-card rounded-xl border border-app-border animate-in fade-in slide-in-from-bottom-2">
                    <p className="text-xs opacity-40 uppercase tracking-widest mb-2">Transcript</p>
                    <p className="text-sm">{voiceTranscript}</p>
                  </div>
                )}
                
                {audioBase64 && !isRecording && (
                  <div className="mt-4 flex justify-center">
                    <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/10 rounded-full border border-emerald-500/20">
                      <div className="w-2 h-2 bg-emerald-500 rounded-full" />
                      <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">Audio Ready for Analysis</span>
                    </div>
                  </div>
                )}
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-2xl flex items-center gap-3 text-red-500 text-sm">
                  <AlertCircle className="w-5 h-5" />
                  {error}
                </div>
              )}

              <div className="pt-6 flex justify-between">
                <button onClick={handleBack} className="opacity-50 font-bold px-8 py-3 rounded-xl flex items-center gap-2 hover:opacity-100 transition-all">
                  <ArrowLeft className="w-5 h-5" /> Back
                </button>
                <button 
                  onClick={verifyVoice}
                  disabled={!audioBase64 || loading}
                  className="bg-emerald-500 text-black font-bold px-8 py-3 rounded-xl flex items-center gap-2 hover:bg-emerald-400 disabled:opacity-50 transition-all"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <>Finalize Verification <ArrowRight className="w-5 h-5" /></>}
                </button>
              </div>
            </div>
          )}

          {step === 'result' && finalResult && (
            <div className="space-y-8 text-center py-8 animate-in zoom-in-95 duration-500">
              <div className="flex flex-col items-center gap-6">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", damping: 12, stiffness: 200 }}
                >
                  {finalResult.decision === 'verified' ? (
                    <div className="w-32 h-32 bg-emerald-500 rounded-full flex items-center justify-center shadow-[0_0_50px_rgba(16,185,129,0.4)]">
                      <ShieldCheck className="w-16 h-16 text-black" />
                    </div>
                  ) : finalResult.decision === 'suspicious' ? (
                    <div className="w-32 h-32 bg-orange-500 rounded-full flex items-center justify-center shadow-[0_0_50px_rgba(249,115,22,0.4)]">
                      <ShieldAlert className="w-16 h-16 text-black" />
                    </div>
                  ) : (
                    <div className="w-32 h-32 bg-red-500 rounded-full flex items-center justify-center shadow-[0_0_50px_rgba(239,68,68,0.4)]">
                      <ShieldX className="w-16 h-16 text-black" />
                    </div>
                  )}
                </motion.div>

                <div className="space-y-2">
                  <h2 className={cn(
                    "text-5xl font-black uppercase tracking-tighter",
                    finalResult.decision === 'verified' ? "text-emerald-500" : 
                    finalResult.decision === 'suspicious' ? "text-orange-500" : "text-red-500"
                  )}>
                    {finalResult.decision === 'verified' ? 'Verification Successful' : 
                     finalResult.decision === 'suspicious' ? 'Manual Review Required' : 'Verification Failed'}
                  </h2>
                  <p className="text-xl opacity-60 font-medium max-w-2xl mx-auto">
                    {finalResult.explanation}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-app-card p-6 rounded-3xl border border-app-border">
                  <p className="text-[10px] uppercase tracking-widest opacity-40 mb-1 font-black">Identity Match</p>
                  <p className="text-3xl font-black text-emerald-500">{faceResult?.matchScore || 0}%</p>
                </div>
                <div className="bg-app-card p-6 rounded-3xl border border-app-border">
                  <p className="text-[10px] uppercase tracking-widest opacity-40 mb-1 font-black">Risk Assessment</p>
                  <p className={cn(
                    "text-3xl font-black",
                    finalResult.riskScore < 30 ? "text-emerald-500" : finalResult.riskScore < 70 ? "text-orange-500" : "text-red-500"
                  )}>
                    {finalResult.riskScore < 30 ? 'Low' : finalResult.riskScore < 70 ? 'Medium' : 'High'}
                  </p>
                </div>
                <div className="bg-app-card p-6 rounded-3xl border border-app-border">
                  <p className="text-[10px] uppercase tracking-widest opacity-40 mb-1 font-black">AI Confidence</p>
                  <p className="text-3xl font-black text-blue-400">{finalResult.confidenceScore}%</p>
                </div>
              </div>

              <div className="bg-app-card p-8 rounded-[40px] border border-app-border text-left relative overflow-hidden">
                <div className="absolute top-0 right-0 p-8 opacity-5">
                  <Fingerprint className="w-32 h-32" />
                </div>
                
                <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-emerald-500" />
                  Detailed Analysis Report
                </h3>
                
                <div className="space-y-6 relative z-10">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between p-4 bg-app-bg/50 rounded-2xl border border-app-border">
                        <span className="text-sm opacity-60">Aadhaar Authenticity</span>
                        <span className="text-sm font-bold text-emerald-500">Verified</span>
                      </div>
                      <div className="flex items-center justify-between p-4 bg-app-bg/50 rounded-2xl border border-app-border">
                        <span className="text-sm opacity-60">Face Liveness</span>
                        <span className={cn("text-sm font-bold", faceResult?.isLive ? "text-emerald-500" : "text-red-500")}>
                          {faceResult?.isLive ? 'Human Detected' : 'Spoof Detected'}
                        </span>
                      </div>
                    </div>
                    <div className="space-y-4">
                      <div className="flex items-center justify-between p-4 bg-app-bg/50 rounded-2xl border border-app-border">
                        <span className="text-sm opacity-60">Voice Match</span>
                        <span className={cn("text-sm font-bold", voiceResult?.codeVerified ? "text-emerald-500" : "text-red-500")}>
                          {voiceResult?.codeVerified ? 'Code Matches' : 'Code Mismatch'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between p-4 bg-app-bg/50 rounded-2xl border border-app-border">
                        <span className="text-sm opacity-60">Deepfake Detection</span>
                        <span className={cn("text-sm font-bold", finalResult.riskScore < 50 ? "text-emerald-500" : "text-red-500")}>
                          {finalResult.riskScore < 50 ? 'No Manipulation' : 'Potential AI Clone'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="p-6 bg-app-bg/50 rounded-3xl border border-app-border">
                    <p className="text-xs uppercase tracking-widest opacity-40 mb-2 font-black">Why this result?</p>
                    <p className="text-sm leading-relaxed opacity-80 italic">
                      "{finalResult.explanation}"
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-4 justify-center pt-8">
                <button 
                  onClick={() => window.location.href = '/'}
                  className="bg-white text-black font-bold px-12 py-4 rounded-2xl hover:bg-emerald-400 transition-all flex-1 shadow-xl"
                >
                  Return to Dashboard
                </button>
                <button 
                  onClick={() => generateKYCReport({
                    userName: user.fullName || user.full_name || 'User',
                    date: new Date().toLocaleDateString(),
                    status: finalResult.decision,
                    confidenceScore: finalResult.confidenceScore,
                    riskScore: finalResult.riskScore,
                    explanation: finalResult.explanation,
                    aadhaarDetails: aadhaarResult,
                    faceDetails: faceResult,
                    voiceDetails: voiceResult
                  })}
                  className="bg-emerald-500 text-black font-bold px-12 py-4 rounded-2xl hover:bg-emerald-400 transition-all flex items-center justify-center gap-2 flex-1 shadow-xl shadow-emerald-500/20"
                >
                  <Download className="w-5 h-5" /> Download PDF Report
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
