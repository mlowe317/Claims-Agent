import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function withRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (error: any) {
      const isRateLimit = error?.status === 429 || 
                          error?.message?.includes('429') || 
                          error?.message?.includes('RESOURCE_EXHAUSTED') ||
                          error?.status === 'RESOURCE_EXHAUSTED';
                          
      if (isRateLimit) {
        attempt++;
        if (attempt >= maxRetries) throw error;
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000; // Exponential backoff with jitter
        console.warn(`Rate limit hit. Retrying in ${Math.round(delay)}ms... (Attempt ${attempt} of ${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries reached");
}

const sendEmailTool: FunctionDeclaration = {
  name: "send_claim_inquiry_email",
  description: "Send an email to the carrier regarding the claim.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      email: { type: Type.STRING, description: "The carrier's email address." },
      subject: { type: Type.STRING, description: "The subject of the email." },
      body: { type: Type.STRING, description: "The body of the email, including the demand amount." },
    },
    required: ["email", "subject", "body"],
  },
};

const voiceOutreachTool: FunctionDeclaration = {
  name: "trigger_voice_outreach",
  description: "Trigger a voice call to the carrier regarding the claim.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      phone: { type: Type.STRING, description: "The carrier's phone number." },
      script: { type: Type.STRING, description: "The script to read to the carrier, including the demand amount." },
    },
    required: ["phone", "script"],
  },
};

export async function processClaim(claimDetails: {
  claimId: string;
  amount: number;
  carrier: string;
  email?: string;
  phone?: string;
}) {
  const systemInstruction = `You are an Autonomous Insurance Claim Agent. Your goal is to reconcile outstanding demands for lenders.

Workflow:
1. Analyze Data: Review the provided claim details (Claim #, Amount, Carrier).
2. Choose Channel: If an email is provided, use the send_claim_inquiry_email tool. If a phone number is provided, use the trigger_voice_outreach tool.
3. Draft Content: Ensure all communication includes the specific Demand Amount to ensure the carrier verifies the correct payment.
4. Handle Responses: Process the actual response from the carrier (provided after tool execution).
5. Output: Return a JSON object for the claim: {"claim_id": "123", "action_taken": "email_sent" | "voice_call_triggered", "status": "pending_carrier_response" | "carrier_approved" | "carrier_denied" | "needs_follow_up", "carrier_response_summary": "Brief summary of what they said"}.`;

  const chat = ai.chats.create({
    model: "gemini-3.1-pro-preview",
    config: {
      systemInstruction,
      tools: [{ functionDeclarations: [sendEmailTool, voiceOutreachTool] }],
      temperature: 0.1,
    },
  });

  const prompt = `Please process the following claim:\n${JSON.stringify(claimDetails, null, 2)}`;
  
  let response;
  try {
    response = await withRetry(() => chat.sendMessage({ message: prompt }));
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    const isRateLimit = error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED');
    const errorMessage = isRateLimit 
      ? "AI Agent is currently busy (Rate Limit Exceeded). Please wait a moment and try again." 
      : `Failed to communicate with AI Agent: ${error.message || "Unknown error"}`;
    throw new Error(errorMessage);
  }
  
  let actionLogs: any[] = [];

  if (response.functionCalls && response.functionCalls.length > 0) {
    for (const call of response.functionCalls) {
      actionLogs.push({
        tool: call.name,
        args: call.args,
      });
      
      let toolResponseText = "In Review"; // Default simulated response

      if (call.name === "send_claim_inquiry_email") {
        try {
          const res = await fetch("/api/send-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to: call.args.email,
              subject: call.args.subject,
              text: call.args.body,
            }),
          });
          
          if (!res.ok) {
            throw new Error(`Server responded with status ${res.status}`);
          }
          
          const data = await res.json();
          if (data.success) {
            toolResponseText = data.simulated 
              ? "Email simulated (RESEND_API_KEY not set). Carrier responded with 'In Review'."
              : "Email sent successfully via Resend. Carrier responded with 'In Review'.";
          } else {
            toolResponseText = "Failed to send email.";
            throw new Error(data.error || "Failed to send email.");
          }
        } catch (err: any) {
          console.error("Failed to call send-email API", err);
          toolResponseText = `Error communicating with email server: ${err.message}`;
          throw new Error(`Email dispatch failed: ${err.message}`);
        }
      } else if (call.name === "trigger_voice_outreach") {
        try {
          const res = await fetch("/api/make-call", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              phone: call.args.phone,
              script: call.args.script,
            }),
          });
          
          if (!res.ok) {
            throw new Error(`Server responded with status ${res.status}`);
          }
          
          const data = await res.json();
          if (data.success) {
            if (data.simulated) {
              // Simulate waiting for a response
              await new Promise(resolve => setTimeout(resolve, 3000));
              toolResponseText = "Voice call simulated. Carrier responded with 'We will review this and get back to you shortly.'";
            } else {
              // Poll for the actual response
              let attempts = 0;
              let callCompleted = false;
              let speechRecorded = "";
              
              while (attempts < 150 && !callCompleted) { // Wait up to 5 minutes
                await new Promise(resolve => setTimeout(resolve, 2000));
                const statusRes = await fetch(`/api/call-status/${data.callSid}`);
                
                if (!statusRes.ok) {
                  throw new Error(`Failed to check call status: ${statusRes.status}`);
                }
                
                const statusData = await statusRes.json();
                
                if (statusData.status === 'completed') {
                  callCompleted = true;
                  speechRecorded = statusData.speech;
                }
                attempts++;
              }
              
              if (callCompleted) {
                toolResponseText = `Voice call completed. Full transcript:\n${speechRecorded}`;
              } else {
                toolResponseText = "Voice call timed out waiting for carrier response.";
                throw new Error("Voice call timed out waiting for carrier response.");
              }
            }
          } else {
            toolResponseText = "Failed to initiate voice call.";
            throw new Error(data.error || "Failed to initiate voice call.");
          }
        } catch (err: any) {
          console.error("Failed to call make-call API", err);
          toolResponseText = `Error communicating with telephony server: ${err.message}`;
          throw new Error(`Voice outreach failed: ${err.message}`);
        }
      }
      
      // Simulate tool response back to the model
      try {
        response = await withRetry(() => chat.sendMessage({
          message: `Function ${call.name} executed. Result: ${toolResponseText}. Please provide the final JSON output.`
        }));
      } catch (error: any) {
        console.error("Gemini API Error during follow-up:", error);
        const isRateLimit = error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED');
        const errorMessage = isRateLimit 
          ? "AI Agent is currently busy (Rate Limit Exceeded). Please wait a moment and try again." 
          : `Failed to send tool results back to AI Agent: ${error.message || "Unknown error"}`;
        throw new Error(errorMessage);
      }
    }
  }

  let resultJson;
  try {
    const text = response.text?.replace(/```json/g, '')?.replace(/```/g, '')?.trim() || "{}";
    resultJson = JSON.parse(text);
  } catch (e: any) {
    console.error("Failed to parse JSON", response.text);
    throw new Error(`Failed to parse AI response as JSON: ${e.message}`);
  }

  return { result: resultJson, logs: actionLogs };
}
