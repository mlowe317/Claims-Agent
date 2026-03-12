import React, { useState, useRef } from 'react';
import { Activity, FileText, Phone, Mail, CheckCircle, Clock, AlertCircle, Send, Plus, ShieldCheck, Upload, List } from 'lucide-react';
import * as xlsx from 'xlsx';
import { processClaim } from './services/gemini';

interface ClaimData {
  claimId: string;
  amount: number;
  carrier: string;
  email: string;
  phone: string;
}

interface ProcessedClaim extends ClaimData {
  status: string;
  actionTaken: string;
  carrierResponseSummary?: string;
  logs: any[];
  timestamp: Date;
}

export default function App() {
  const [claims, setClaims] = useState<ProcessedClaim[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeTab, setActiveTab] = useState<'manual' | 'bulk'>('manual');
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [formData, setFormData] = useState<ClaimData>({
    claimId: `CLM-${Math.floor(Math.random() * 10000)}`,
    amount: 1500.00,
    carrier: 'Acme Insurance Co.',
    email: 'claims@acmeins.com',
    phone: '',
  });

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: name === 'amount' ? parseFloat(value) || 0 : value
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);
    setError(null);

    try {
      const { result, logs } = await processClaim(formData);
      
      const newProcessedClaim: ProcessedClaim = {
        ...formData,
        status: result.status || 'unknown',
        actionTaken: result.action_taken || 'none',
        carrierResponseSummary: result.carrier_response_summary,
        logs: logs,
        timestamp: new Date(),
      };

      setClaims(prev => [newProcessedClaim, ...prev]);
      
      // Reset form with new random ID
      setFormData(prev => ({
        ...prev,
        claimId: `CLM-${Math.floor(Math.random() * 10000)}`,
      }));
    } catch (err: any) {
      console.error("Error processing claim:", err);
      setError(err.message || "Failed to process claim. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = xlsx.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = xlsx.utils.sheet_to_json(ws);

        // Map data to ClaimData
        const claimsToProcess: ClaimData[] = data.map((row: any) => ({
          claimId: String(row['Claim Number'] || row['ClaimId'] || row['claimId'] || `CLM-${Math.floor(Math.random() * 10000)}`),
          amount: parseFloat(row['Demand Amount'] || row['Amount'] || row['amount']) || 0,
          carrier: String(row['Carrier Name'] || row['Carrier'] || row['carrier'] || 'Unknown Carrier'),
          email: String(row['Email Address'] || row['Email'] || row['email'] || ''),
          phone: String(row['Phone Number'] || row['Phone'] || row['phone'] || ''),
        }));

        if (claimsToProcess.length === 0) {
          alert("No valid claims found in the Excel file.");
          return;
        }

        setIsProcessing(true);
        setError(null);
        setBulkProgress({ current: 0, total: claimsToProcess.length });
        
        let errorCount = 0;

        for (let i = 0; i < claimsToProcess.length; i++) {
          const claim = claimsToProcess[i];
          try {
            const { result, logs } = await processClaim(claim);
            
            const newProcessedClaim: ProcessedClaim = {
              ...claim,
              status: result.status || 'unknown',
              actionTaken: result.action_taken || 'none',
              carrierResponseSummary: result.carrier_response_summary,
              logs: logs,
              timestamp: new Date(),
            };

            setClaims(prev => [newProcessedClaim, ...prev]);
          } catch (err: any) {
            console.error(`Error processing claim ${claim.claimId}:`, err);
            errorCount++;
            
            // Still add it to the list but mark it as failed
            const failedClaim: ProcessedClaim = {
              ...claim,
              status: 'error',
              actionTaken: 'failed',
              carrierResponseSummary: `Error: ${err.message || "Unknown error"}`,
              logs: [],
              timestamp: new Date(),
            };
            setClaims(prev => [failedClaim, ...prev]);
          }
          setBulkProgress({ current: i + 1, total: claimsToProcess.length });
        }
        
        if (errorCount > 0) {
          setError(`Completed with ${errorCount} error(s). See log for details.`);
        }
      } catch (err: any) {
        console.error("Error parsing Excel file:", err);
        setError("Failed to parse Excel file. Please ensure it's a valid .xlsx or .csv file.");
      } finally {
        setIsProcessing(false);
        setBulkProgress({ current: 0, total: 0 });
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    };
    reader.readAsBinaryString(file);
  };

  return (
    <div className="min-h-screen bg-[#f5f5f5] font-sans text-gray-900">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 sticky top-0 z-10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg">
            <ShieldCheck className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Autonomous Claim Agent</h1>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Reconciliation Dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-100 px-3 py-1.5 rounded-full">
            <Activity className="w-4 h-4 text-emerald-500" />
            <span>System Online</span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Input Form / Upload */}
        <div className="lg:col-span-4 space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="flex border-b border-gray-100">
              <button
                onClick={() => setActiveTab('manual')}
                className={`flex-1 py-3 px-4 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'manual' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-600' : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                <Plus className="w-4 h-4" />
                Manual Entry
              </button>
              <button
                onClick={() => setActiveTab('bulk')}
                className={`flex-1 py-3 px-4 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'bulk' ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-600' : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                <Upload className="w-4 h-4" />
                Bulk Upload
              </button>
            </div>

            <div className="p-6">
              {error && (
                <div className="mb-6 bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="text-sm font-semibold text-red-800">Processing Error</h4>
                    <p className="text-sm text-red-700 mt-1">{error}</p>
                  </div>
                </div>
              )}

              {activeTab === 'manual' ? (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Claim Number</label>
                    <input
                      type="text"
                      name="claimId"
                      value={formData.claimId}
                      onChange={handleInputChange}
                      required
                      className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Demand Amount ($)</label>
                    <input
                      type="number"
                      name="amount"
                      step="0.01"
                      value={formData.amount}
                      onChange={handleInputChange}
                      required
                      className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Carrier Name</label>
                    <input
                      type="text"
                      name="carrier"
                      value={formData.carrier}
                      onChange={handleInputChange}
                      required
                      className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                    />
                  </div>

                  <div className="pt-2 border-t border-gray-100">
                    <p className="text-xs text-gray-500 mb-3">Provide at least one contact method.</p>
                    
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                          <Mail className="w-3 h-3" /> Email Address
                        </label>
                        <input
                          type="email"
                          name="email"
                          value={formData.email}
                          onChange={handleInputChange}
                          className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                          placeholder="claims@carrier.com"
                        />
                      </div>
                      
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                          <Phone className="w-3 h-3" /> Phone Number
                        </label>
                        <input
                          type="tel"
                          name="phone"
                          value={formData.phone}
                          onChange={handleInputChange}
                          className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                          placeholder="(555) 123-4567"
                        />
                      </div>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={isProcessing || (!formData.email && !formData.phone)}
                    className="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white font-medium py-3 px-4 rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    {isProcessing ? (
                      <>
                        <Activity className="w-5 h-5 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      <>
                        <Send className="w-5 h-5" />
                        Dispatch Agent
                      </>
                    )}
                  </button>
                </form>
              ) : (
                <div className="space-y-6">
                  <div className="text-center p-8 border-2 border-dashed border-gray-200 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors relative">
                    <input 
                      type="file" 
                      accept=".xlsx, .xls, .csv" 
                      onChange={handleFileUpload}
                      disabled={isProcessing}
                      ref={fileInputRef}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                    />
                    <Upload className="w-10 h-10 text-indigo-400 mx-auto mb-3" />
                    <h3 className="text-sm font-semibold text-gray-900 mb-1">Upload Excel File</h3>
                    <p className="text-xs text-gray-500">Drag and drop or click to browse</p>
                    <p className="text-xs text-gray-400 mt-4">Supported columns: Claim Number, Demand Amount, Carrier Name, Email Address, Phone Number</p>
                  </div>

                  {isProcessing && bulkProgress.total > 0 && (
                    <div className="bg-indigo-50 rounded-xl p-4 border border-indigo-100">
                      <div className="flex justify-between text-sm font-medium text-indigo-900 mb-2">
                        <span>Processing Claims...</span>
                        <span>{bulkProgress.current} / {bulkProgress.total}</span>
                      </div>
                      <div className="w-full bg-indigo-200 rounded-full h-2.5">
                        <div 
                          className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300" 
                          style={{ width: `${(bulkProgress.current / bulkProgress.total) * 100}%` }}
                        ></div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Processed Claims */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <FileText className="w-5 h-5 text-gray-400" />
                Reconciliation Log
              </h2>
              <span className="text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded-full font-medium">
                {claims.length} Processed
              </span>
            </div>
            
            {claims.length === 0 ? (
              <div className="p-12 text-center text-gray-500">
                <Clock className="w-12 h-12 mx-auto text-gray-300 mb-3" />
                <p className="text-lg font-medium text-gray-900">No claims processed yet</p>
                <p className="text-sm mt-1">Submit a claim demand to see the autonomous agent in action.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {claims.map((claim, idx) => (
                  <div key={idx} className="p-6 hover:bg-gray-50 transition-colors">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <span className="font-mono text-lg font-semibold text-gray-900">{claim.claimId}</span>
                          <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-amber-100 text-amber-800 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {claim.status.replace(/_/g, ' ').toUpperCase()}
                          </span>
                        </div>
                        <p className="text-sm text-gray-600">{claim.carrier}</p>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-xl font-light text-gray-900">
                          ${claim.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <p className="text-xs text-gray-400 mt-1">
                          {claim.timestamp.toLocaleTimeString()}
                        </p>
                      </div>
                    </div>

                    {claim.carrierResponseSummary && (
                      <div className="mb-4 bg-indigo-50 border border-indigo-100 rounded-xl p-4">
                        <h4 className="text-xs font-semibold text-indigo-800 uppercase tracking-wider mb-1">Carrier Response</h4>
                        <p className="text-sm text-indigo-900">{claim.carrierResponseSummary}</p>
                      </div>
                    )}

                    {/* Action Logs */}
                    <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Agent Actions</h4>
                      <div className="space-y-3">
                        {claim.logs.map((log, logIdx) => (
                          <div key={logIdx} className="flex gap-3 text-sm">
                            <div className="mt-0.5">
                              {log.tool === 'send_claim_inquiry_email' ? (
                                <Mail className="w-4 h-4 text-blue-500" />
                              ) : log.tool === 'trigger_voice_outreach' ? (
                                <Phone className="w-4 h-4 text-emerald-500" />
                              ) : (
                                <Activity className="w-4 h-4 text-gray-400" />
                              )}
                            </div>
                            <div className="flex-1">
                              <p className="font-medium text-gray-900">
                                {log.tool === 'send_claim_inquiry_email' ? 'Drafted & Sent Email' : 
                                 log.tool === 'trigger_voice_outreach' ? 'Initiated Voice Call' : log.tool}
                              </p>
                              {log.args && (
                                <div className="mt-2 bg-white border border-gray-200 rounded-lg p-3 font-mono text-xs text-gray-600 overflow-x-auto">
                                  {log.tool === 'send_claim_inquiry_email' && (
                                    <div className="space-y-1">
                                      <p><span className="text-gray-400">To:</span> {log.args.email}</p>
                                      <p><span className="text-gray-400">Subject:</span> {log.args.subject}</p>
                                      <p className="mt-2 text-gray-800 whitespace-pre-wrap">{log.args.body}</p>
                                    </div>
                                  )}
                                  {log.tool === 'trigger_voice_outreach' && (
                                    <div className="space-y-1">
                                      <p><span className="text-gray-400">Phone:</span> {log.args.phone}</p>
                                      <p className="mt-2 text-gray-800 whitespace-pre-wrap italic">"{log.args.script}"</p>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                        {claim.logs.length === 0 && (
                          <p className="text-sm text-gray-500 italic">No specific tool actions recorded.</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
