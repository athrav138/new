import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { History as HistoryIcon, ShieldCheck, ShieldAlert, ShieldX, Calendar, ArrowRight, Download, Video, FileVideo, X, AlertCircle, CheckCircle2, Camera, Mic } from 'lucide-react';
import { cn } from '../lib/utils';
import { generateKYCReport } from '../lib/reportGenerator';
import { auth, rtdb } from '../lib/firebase';
import { ref, get } from 'firebase/database';

export default function HistoryPage({ user }: { user: any }) {
  const [kycRecords, setKycRecords] = useState<any[]>([]);
  const [videoRecords, setVideoRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'kyc' | 'video'>('kyc');
  const [selectedVideo, setSelectedVideo] = useState<any>(null);
  const [selectedKYC, setSelectedKYC] = useState<any>(null);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    try {
      // 1. Fetch from Local API (for existing data)
      const [kycRes, videoRes] = await Promise.all([
        fetch('/api/kyc/history', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }),
        fetch('/api/video/history', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } })
      ]);
      
      const kycData = await kycRes.json();
      const videoData = await videoRes.json();
      
      // 2. Fetch from Realtime Database
      let rtdbKycData: any[] = [];
      if (rtdb) {
        try {
          const kycRef = ref(rtdb, `kyc_users/${user.id}`);
          const snapshot = await get(kycRef);
          const data = snapshot.val();
          if (data) {
            rtdbKycData = Object.entries(data).map(([id, val]: [string, any]) => ({
              id,
              ...val,
              // Map RTDB fields to match local API fields for the UI
              status: val.verificationStatus?.toLowerCase() || 'verified',
              confidence_score: val.confidenceScore,
              risk_score: val.riskScore,
              final_decision: val.verificationStatus === 'Approved' ? 'Verification Successful' : 'Verification Rejected',
              created_at: val.createdAt || new Date().toISOString(),
              isRTDB: true
            }));
          }
        } catch (fbErr) {
          console.warn("RTDB fetch failed:", fbErr);
        }
      }

      // Merge and sort
      const allKyc = [...rtdbKycData, ...kycData].sort((a, b) => 
        new Date(b.created_at || b.createdAt).getTime() - new Date(a.created_at || a.createdAt).getTime()
      );
      
      setKycRecords(allKyc);
      setVideoRecords(videoData);
    } catch (err) {
      console.error("Failed to fetch history:", err);
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'verified': return <ShieldCheck className="w-5 h-5 text-emerald-500" />;
      case 'suspicious': return <ShieldAlert className="w-5 h-5 text-orange-500" />;
      case 'fake': return <ShieldX className="w-5 h-5 text-red-500" />;
      default: return <HistoryIcon className="w-5 h-5 opacity-40" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'verified': return "text-emerald-500 bg-emerald-500/10 border-emerald-500/20";
      case 'suspicious': return "text-orange-500 bg-orange-500/10 border-orange-500/20";
      case 'fake': return "text-red-500 bg-red-500/10 border-red-500/20";
      default: return "text-gray-500 bg-gray-500/10 border-gray-500/20";
    }
  };

  const parseAnalysisData = (data: any) => {
    if (typeof data === 'object' && data !== null) return data;
    try {
      return JSON.parse(data || '{}');
    } catch (e) {
      console.error("Failed to parse analysis data:", e);
      return {};
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="flex items-center gap-4 mb-12">
        <div className="p-4 bg-emerald-500/10 rounded-3xl border border-emerald-500/20">
          <HistoryIcon className="w-8 h-8 text-emerald-500" />
        </div>
        <div>
          <h1 className="text-4xl font-black tracking-tight">Verification <span className="text-emerald-500">History</span></h1>
          <p className="opacity-50">Review your past KYC attempts and video deepfake analyses.</p>
        </div>
      </div>

      <div className="flex gap-2 mb-8 bg-app-card p-1.5 rounded-2xl border border-app-border w-fit">
        <button 
          onClick={() => setActiveTab('kyc')}
          className={cn(
            "px-6 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center gap-2",
            activeTab === 'kyc' ? "bg-emerald-500 text-black shadow-lg shadow-emerald-500/20" : "opacity-50 hover:opacity-100"
          )}
        >
          <ShieldCheck className="w-4 h-4" />
          KYC Verifications
        </button>
        <button 
          onClick={() => setActiveTab('video')}
          className={cn(
            "px-6 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center gap-2",
            activeTab === 'video' ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20" : "opacity-50 hover:opacity-100"
          )}
        >
          <Video className="w-4 h-4" />
          Video Analyses
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-24">
          <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
        </div>
      ) : (
        <AnimatePresence mode="wait">
          {activeTab === 'kyc' ? (
            <motion.div 
              key="kyc"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="grid gap-6"
            >
              {kycRecords.length === 0 ? (
                <div className="bg-app-card border border-app-border rounded-[40px] p-24 text-center">
                  <h2 className="text-2xl font-bold mb-2">No KYC records</h2>
                  <p className="opacity-50">You haven't completed any KYC verifications yet.</p>
                </div>
              ) : (
                kycRecords.map((record, index) => (
                  <motion.div
                    key={record.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1 }}
                    className="bg-app-card border border-app-border rounded-[32px] p-6 sm:p-8 hover:border-emerald-500/30 transition-all group cursor-pointer"
                    onClick={() => setSelectedKYC(record)}
                  >
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                      <div className="flex items-center gap-6">
                        <div className={cn("w-16 h-16 rounded-2xl flex items-center justify-center border shrink-0", getStatusColor(record.status))}>
                          {getStatusIcon(record.status)}
                        </div>
                        <div>
                          <div className="flex items-center gap-3 mb-1">
                            <span className={cn("text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded border", getStatusColor(record.status))}>
                              {record.status}
                            </span>
                            <div className="flex items-center gap-1.5 opacity-40 text-[10px] font-bold uppercase tracking-widest">
                              <Calendar className="w-3 h-3" />
                              {new Date(record.created_at).toLocaleString()}
                            </div>
                          </div>
                          <h3 className="text-lg font-bold line-clamp-1">{record.final_decision}</h3>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 sm:gap-8">
                        <div className="text-right hidden sm:block">
                          <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mb-1">Risk Score</p>
                          <p className={cn("text-xl font-black", record.risk_score < 30 ? "text-emerald-500" : record.risk_score < 70 ? "text-orange-500" : "text-red-500")}>
                            {record.risk_score}/100
                          </p>
                        </div>
                        <div className="text-right hidden sm:block">
                          <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mb-1">Confidence</p>
                          <p className="text-xl font-black text-blue-400">{record.confidence_score}%</p>
                        </div>
                        
                        <div className="bg-emerald-500/10 text-emerald-500 group-hover:bg-emerald-500 group-hover:text-black p-4 rounded-2xl transition-all border border-emerald-500/20 group-hover:scale-105">
                          <ArrowRight className="w-5 h-5" />
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))
              )}
            </motion.div>
          ) : (
            <motion.div 
              key="video"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="grid gap-6"
            >
              {videoRecords.length === 0 ? (
                <div className="bg-app-card border border-app-border rounded-[40px] p-24 text-center">
                  <h2 className="text-2xl font-bold mb-2">No video records</h2>
                  <p className="opacity-50">You haven't performed any video deepfake analyses yet.</p>
                </div>
              ) : (
                videoRecords.map((record, index) => (
                  <motion.div
                    key={record.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1 }}
                    className="bg-app-card border border-app-border rounded-[32px] p-6 sm:p-8 hover:border-indigo-500/30 transition-all group"
                  >
                    <div 
                      onClick={() => setSelectedVideo(record)}
                      className="flex flex-col md:flex-row md:items-center justify-between gap-6 cursor-pointer"
                    >
                      <div className="flex items-center gap-6">
                        <div className={cn(
                          "w-16 h-16 rounded-2xl flex items-center justify-center border shrink-0",
                          record.is_deepfake ? "text-red-500 bg-red-500/10 border-red-500/20" : "text-emerald-500 bg-emerald-500/10 border-emerald-500/20"
                        )}>
                          {record.is_deepfake ? <ShieldX className="w-6 h-6" /> : <ShieldCheck className="w-6 h-6" />}
                        </div>
                        <div>
                          <div className="flex items-center gap-3 mb-1">
                            <span className={cn(
                              "text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded border",
                              record.is_deepfake ? "text-red-500 border-red-500/20" : "text-emerald-500 border-emerald-500/20"
                            )}>
                              {record.is_deepfake ? 'Deepfake' : 'Authentic'}
                            </span>
                            <div className="flex items-center gap-1.5 opacity-40 text-[10px] font-bold uppercase tracking-widest">
                              <Calendar className="w-3 h-3" />
                              {new Date(record.created_at).toLocaleString()}
                            </div>
                          </div>
                          <h3 className="text-lg font-bold line-clamp-1 flex items-center gap-2">
                            <FileVideo className="w-4 h-4 opacity-40" />
                            {record.video_name}
                          </h3>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 sm:gap-8">
                        <div className="text-right hidden sm:block">
                          <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mb-1">Risk Level</p>
                          <p className={cn(
                            "text-xl font-black capitalize",
                            record.risk_level === 'high' ? "text-red-500" : record.risk_level === 'medium' ? "text-orange-500" : "text-emerald-500"
                          )}>
                            {record.risk_level}
                          </p>
                        </div>
                        <div className="text-right hidden sm:block">
                          <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mb-1">Confidence</p>
                          <p className="text-xl font-black text-blue-400">{record.confidence_score}%</p>
                        </div>
                        
                        <div className="bg-indigo-500/10 text-indigo-500 group-hover:bg-indigo-500 group-hover:text-white p-4 rounded-2xl transition-all border border-indigo-500/20 group-hover:scale-105">
                          <ArrowRight className="w-5 h-5" />
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {/* KYC Detail Modal */}
      <AnimatePresence>
        {selectedKYC && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedKYC(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-3xl bg-app-card border border-app-border rounded-[32px] overflow-hidden shadow-2xl"
            >
              <div className="p-6 sm:p-8 border-b border-app-border flex items-center justify-between bg-emerald-500/5">
                <div className="flex items-center gap-4">
                  <div className={cn("w-12 h-12 rounded-2xl flex items-center justify-center border", getStatusColor(selectedKYC.status))}>
                    {getStatusIcon(selectedKYC.status)}
                  </div>
                  <div>
                    <h2 className="text-xl font-bold">KYC Verification Details</h2>
                    <p className="text-xs opacity-40 uppercase tracking-widest font-bold">
                      {new Date(selectedKYC.created_at || selectedKYC.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => {
                      if (selectedKYC.isRTDB) {
                        generateKYCReport({
                          userName: selectedKYC.name,
                          date: new Date(selectedKYC.createdAt).toLocaleDateString(),
                          status: selectedKYC.status,
                          confidenceScore: selectedKYC.confidenceScore,
                          riskScore: selectedKYC.risk_score,
                          explanation: selectedKYC.explanation || selectedKYC.final_decision,
                          aadhaarDetails: { aadhaarNumber: selectedKYC.aadhaarNumber || 'N/A' },
                          faceDetails: selectedKYC.faceResult || {},
                          voiceDetails: selectedKYC.voiceResult || {}
                        });
                      } else {
                        generateKYCReport({
                          userName: user.fullName,
                          date: new Date(selectedKYC.created_at).toLocaleDateString(),
                          status: selectedKYC.status,
                          confidenceScore: selectedKYC.confidence_score,
                          riskScore: selectedKYC.risk_score,
                          explanation: selectedKYC.final_decision,
                          aadhaarDetails: parseAnalysisData(selectedKYC.aadhaar_analysis),
                          faceDetails: parseAnalysisData(selectedKYC.face_analysis),
                          voiceDetails: parseAnalysisData(selectedKYC.voice_analysis)
                        });
                      }
                    }}
                    className="p-2.5 bg-emerald-500/10 text-emerald-500 rounded-xl hover:bg-emerald-500 hover:text-black transition-all border border-emerald-500/20"
                    title="Download PDF Report"
                  >
                    <Download className="w-5 h-5" />
                  </button>
                  <button 
                    onClick={() => setSelectedKYC(null)}
                    className="p-2.5 hover:bg-app-bg rounded-xl transition-colors border border-transparent hover:border-app-border"
                  >
                    <X className="w-6 h-6" />
                  </button>
                </div>
              </div>

              <div className="p-6 sm:p-8 max-h-[70vh] overflow-y-auto custom-scrollbar">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                  <div className="bg-app-bg p-4 rounded-2xl border border-app-border text-center">
                    <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mb-1">Status</p>
                    <p className={cn("font-bold capitalize", getStatusColor(selectedKYC.status).split(' ')[0])}>
                      {selectedKYC.status}
                    </p>
                  </div>
                  <div className="bg-app-bg p-4 rounded-2xl border border-app-border text-center">
                    <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mb-1">Risk Score</p>
                    <p className={cn("font-bold", selectedKYC.risk_score < 30 ? "text-emerald-500" : selectedKYC.risk_score < 70 ? "text-orange-500" : "text-red-500")}>
                      {selectedKYC.risk_score}/100
                    </p>
                  </div>
                  <div className="bg-app-bg p-4 rounded-2xl border border-app-border text-center">
                    <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mb-1">Confidence</p>
                    <p className="font-bold text-blue-400">{selectedKYC.confidence_score}%</p>
                  </div>
                </div>

                <div className="space-y-8">
                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-widest opacity-40 mb-3 flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4" /> Final Decision
                    </h3>
                    <div className="bg-app-bg p-5 rounded-2xl border border-app-border">
                      <p className="text-sm leading-relaxed opacity-80 font-medium">
                        {selectedKYC.final_decision}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Aadhaar Details */}
                    <div className="space-y-3">
                      <h3 className="text-sm font-bold uppercase tracking-widest opacity-40 flex items-center gap-2">
                        <FileVideo className="w-4 h-4" /> Aadhaar Analysis
                      </h3>
                      <div className="bg-app-bg p-5 rounded-2xl border border-app-border space-y-4">
                        <div className="flex justify-between items-center pb-3 border-b border-app-border/50">
                          <span className="text-xs opacity-50">Aadhaar Number</span>
                          <span className="text-xs font-mono font-bold">
                            {selectedKYC.isRTDB ? selectedKYC.aadhaarNumber || 'N/A' : parseAnalysisData(selectedKYC.aadhaar_analysis).aadhaarNumber || 'N/A'}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-xs opacity-50">OCR Confidence</span>
                          <span className="text-xs font-bold text-emerald-500">
                            {selectedKYC.isRTDB ? '98%' : `${parseAnalysisData(selectedKYC.aadhaar_analysis).confidence || 0}%`}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Face Details */}
                    <div className="space-y-3">
                      <h3 className="text-sm font-bold uppercase tracking-widest opacity-40 flex items-center gap-2">
                        <Camera className="w-4 h-4" /> Face Liveness
                      </h3>
                      <div className="bg-app-bg p-5 rounded-2xl border border-app-border space-y-4">
                        <div className="flex justify-between items-center pb-3 border-b border-app-border/50">
                          <span className="text-xs opacity-50">Liveness Check</span>
                          <span className={cn("text-xs font-bold", (selectedKYC.isRTDB ? selectedKYC.faceResult?.isLive : parseAnalysisData(selectedKYC.face_analysis).isLive) ? "text-emerald-500" : "text-red-500")}>
                            {(selectedKYC.isRTDB ? selectedKYC.faceResult?.isLive : parseAnalysisData(selectedKYC.face_analysis).isLive) ? 'Passed' : 'Failed'}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-xs opacity-50">Identity Match</span>
                          <span className="text-xs font-bold text-blue-400">
                            {selectedKYC.isRTDB ? `${selectedKYC.faceResult?.matchScore || 0}%` : `${parseAnalysisData(selectedKYC.face_analysis).matchScore || 0}%`}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Voice Details */}
                    <div className="md:col-span-2 space-y-3">
                      <h3 className="text-sm font-bold uppercase tracking-widest opacity-40 flex items-center gap-2">
                        <Mic className="w-4 h-4" /> Voice Authentication
                      </h3>
                      <div className="bg-app-bg p-5 rounded-2xl border border-app-border">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] opacity-40 font-bold uppercase">Transcript Match</span>
                            <span className={cn("text-xs font-bold", (selectedKYC.isRTDB ? selectedKYC.voiceResult?.matchesText : parseAnalysisData(selectedKYC.voice_analysis).matchesText) ? "text-emerald-500" : "text-red-500")}>
                              {(selectedKYC.isRTDB ? selectedKYC.voiceResult?.matchesText : parseAnalysisData(selectedKYC.voice_analysis).matchesText) ? 'Verified' : 'Mismatch'}
                            </span>
                          </div>
                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] opacity-40 font-bold uppercase">Deepfake Risk</span>
                            <span className={cn("text-xs font-bold", (selectedKYC.isRTDB ? selectedKYC.voiceResult?.riskLevel === 'low' : parseAnalysisData(selectedKYC.voice_analysis).riskLevel < 30) ? "text-emerald-500" : "text-red-500")}>
                              {selectedKYC.isRTDB ? selectedKYC.voiceResult?.riskLevel : `${parseAnalysisData(selectedKYC.voice_analysis).riskLevel || 0}%`}
                            </span>
                          </div>
                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] opacity-40 font-bold uppercase">Confidence</span>
                            <span className="text-xs font-bold text-blue-400">
                              {selectedKYC.isRTDB ? `${selectedKYC.voiceResult?.confidence || 0}%` : `${parseAnalysisData(selectedKYC.voice_analysis).confidence || 0}%`}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-6 sm:p-8 bg-app-bg/50 border-t border-app-border flex justify-end">
                <button 
                  onClick={() => setSelectedKYC(null)}
                  className="px-8 py-3 bg-white text-black font-bold rounded-2xl hover:bg-emerald-400 transition-all"
                >
                  Close Details
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Video Detail Modal */}
      <AnimatePresence>
        {selectedVideo && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedVideo(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-2xl bg-app-card border border-app-border rounded-[32px] overflow-hidden shadow-2xl"
            >
              <div className="p-6 sm:p-8 border-b border-app-border flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className={cn(
                    "w-12 h-12 rounded-2xl flex items-center justify-center border",
                    selectedVideo.is_deepfake ? "text-red-500 bg-red-500/10 border-red-500/20" : "text-emerald-500 bg-emerald-500/10 border-emerald-500/20"
                  )}>
                    {selectedVideo.is_deepfake ? <ShieldX className="w-6 h-6" /> : <ShieldCheck className="w-6 h-6" />}
                  </div>
                  <div>
                    <h2 className="text-xl font-bold">{selectedVideo.video_name}</h2>
                    <p className="text-xs opacity-40 uppercase tracking-widest font-bold">
                      {new Date(selectedVideo.created_at).toLocaleString()}
                    </p>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedVideo(null)}
                  className="p-2 hover:bg-app-bg rounded-xl transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="p-6 sm:p-8 max-h-[70vh] overflow-y-auto custom-scrollbar">
                <div className="grid grid-cols-3 gap-4 mb-8">
                  <div className="bg-app-bg p-4 rounded-2xl border border-app-border text-center">
                    <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mb-1">Status</p>
                    <p className={cn("font-bold", selectedVideo.is_deepfake ? "text-red-500" : "text-emerald-500")}>
                      {selectedVideo.is_deepfake ? 'Deepfake' : 'Authentic'}
                    </p>
                  </div>
                  <div className="bg-app-bg p-4 rounded-2xl border border-app-border text-center">
                    <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mb-1">Risk</p>
                    <p className={cn("font-bold capitalize", selectedVideo.risk_level === 'high' ? "text-red-500" : selectedVideo.risk_level === 'medium' ? "text-orange-500" : "text-emerald-500")}>
                      {selectedVideo.risk_level}
                    </p>
                  </div>
                  <div className="bg-app-bg p-4 rounded-2xl border border-app-border text-center">
                    <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mb-1">Confidence</p>
                    <p className="font-bold text-blue-400">{selectedVideo.confidence_score}%</p>
                  </div>
                </div>

                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-widest opacity-40 mb-3">AI Reasoning</h3>
                    <div className="bg-app-bg p-4 rounded-2xl border border-app-border">
                      <p className="text-sm leading-relaxed opacity-80 italic">
                        "{parseAnalysisData(selectedVideo.analysis_data).reasoning || 'No reasoning provided.'}"
                      </p>
                    </div>
                  </div>

                  {parseAnalysisData(selectedVideo.analysis_data).anomalies?.length > 0 && (
                    <div>
                      <h3 className="text-sm font-bold uppercase tracking-widest opacity-40 mb-3">Detected Anomalies</h3>
                      <div className="grid gap-2">
                        {parseAnalysisData(selectedVideo.analysis_data).anomalies.map((anomaly: string, i: number) => (
                          <div key={i} className="flex items-center gap-3 bg-red-500/5 border border-red-500/10 p-3 rounded-xl">
                            <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                            <span className="text-xs opacity-80">{anomaly}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {parseAnalysisData(selectedVideo.analysis_data).frameAnalysis?.length > 0 && (
                    <div>
                      <h3 className="text-sm font-bold uppercase tracking-widest opacity-40 mb-3">Frame-by-Frame Analysis</h3>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {parseAnalysisData(selectedVideo.analysis_data).frameAnalysis.map((frame: any, i: number) => (
                          <div key={i} className="bg-app-bg border border-app-border p-3 rounded-xl flex flex-col items-center gap-1">
                            <span className="text-[10px] opacity-40 font-bold">Frame {frame.frame}</span>
                            <div className="flex items-center gap-1.5">
                              {frame.status.toLowerCase().includes('suspicious') || frame.status.toLowerCase().includes('fake') ? (
                                <ShieldX className="w-3 h-3 text-red-500" />
                              ) : (
                                <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                              )}
                              <span className={cn(
                                "text-[10px] font-bold",
                                frame.status.toLowerCase().includes('suspicious') || frame.status.toLowerCase().includes('fake') ? "text-red-500" : "text-emerald-500"
                              )}>
                                {frame.status}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-6 sm:p-8 bg-app-bg/50 border-t border-app-border flex justify-end">
                <button 
                  onClick={() => setSelectedVideo(null)}
                  className="px-8 py-3 bg-white text-black font-bold rounded-2xl hover:bg-emerald-400 transition-all"
                >
                  Close Analysis
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
