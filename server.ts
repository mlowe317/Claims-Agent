import express from "express";
import { createServer as createViteServer } from "vite";
import { Resend } from "resend";
import twilio from "twilio";
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

const callResults = new Map<string, { status: string, speech?: string, history: any[], phone?: string }>();

function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey);
}

async function markCallCompleted(callSid: string, callData: any) {
  if (callData.status === 'completed') return;
  
  callData.status = 'completed';
  callData.speech = callData.history.map((h: any) => `${h.role}: ${h.parts[0].text}`).join('\n');
  
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase
        .from('calls')
        .insert([{
          call_sid: callSid,
          status: 'completed',
          transcript: callData.speech,
          phone_number: callData.phone || 'unknown'
        }]);
      if (error) console.error("Supabase insert error:", error);
    } catch (err) {
      console.error("Failed to save to Supabase:", err);
    }
  }
}

function escapeXml(unsafe: string) {
    if (!unsafe) return "";
    return unsafe.replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}

async function withRetry<T>(operation: () => Promise<T>, maxRetries = 2): Promise<T> {
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
        // Keep delay very short for webhooks to avoid Twilio 15s timeout
        const delay = 1000 + Math.random() * 500; 
        console.warn(`Rate limit hit in webhook. Retrying in ${Math.round(delay)}ms... (Attempt ${attempt} of ${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries reached");
}

function getPublicUrl() {
  let url = (process.env.APP_URL || '').replace(/\/$/, '');
  // The ais-dev URL is often protected by authentication in AI Studio.
  // We must use the ais-pre (shared) URL for external webhooks like Twilio.
  if (url.includes('ais-dev-')) {
    url = url.replace('ais-dev-', 'ais-pre-');
  }
  return url;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // API Routes
  app.post("/api/send-email", async (req, res) => {
    try {
      const { to, subject, text } = req.body;
      
      if (!process.env.RESEND_API_KEY) {
        throw new Error("RESEND_API_KEY is not set. Cannot send a real email.");
      }

      const resend = new Resend(process.env.RESEND_API_KEY);
      
      const data = await resend.emails.send({
        from: "Acme Claims <onboarding@resend.dev>", // Resend's default testing domain
        to: [to],
        subject: subject,
        text: text,
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error("Error sending email:", error);
      res.status(500).json({ error: "Failed to send email" });
    }
  });

  app.post("/api/email-webhook", async (req, res) => {
    try {
      const payload = req.body;
      
      // Resend sends a verification payload or an email.received payload
      if (payload.type === "email.received") {
        const emailData = payload.data;
        console.log(`Received email reply from ${emailData.from} with subject: ${emailData.subject}`);
        
        const supabase = getSupabase();
        if (supabase) {
          const { error } = await supabase
            .from('email_replies')
            .insert([{
              from_email: emailData.from,
              to_email: emailData.to[0],
              subject: emailData.subject,
              text_body: emailData.text,
              html_body: emailData.html
            }]);
            
          if (error) {
            console.error("Supabase insert error for email reply:", error);
          }
        }
      }
      
      // Always return 200 OK so Resend knows we received it
      res.sendStatus(200);
    } catch (error) {
      console.error("Error processing email webhook:", error);
      res.status(500).send("Webhook error");
    }
  });

  app.post("/api/make-call", async (req, res) => {
    try {
      const { phone, script } = req.body;
      
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const fromNumber = process.env.TWILIO_PHONE_NUMBER;
      const appUrl = getPublicUrl();

      if (!accountSid || !authToken || !fromNumber || !appUrl) {
        throw new Error("Twilio credentials or APP_URL missing. Cannot make a real phone call.");
      }

      const client = twilio(accountSid, authToken);
      
      // Create TwiML to read the script and gather speech response
      const twiml = `
        <Response>
          <Gather input="speech" action="${appUrl}/api/twilio-webhook" speechTimeout="auto" timeout="10">
            <Say voice="Polly.Matthew">${escapeXml(script)}</Say>
          </Gather>
          <Say voice="Polly.Matthew">We did not receive a response. Goodbye.</Say>
        </Response>
      `;

      const call = await client.calls.create({
        twiml: twiml,
        to: phone,
        from: fromNumber,
        statusCallback: `${appUrl}/api/twilio-status`,
        statusCallbackEvent: ['completed'],
      });

      callResults.set(call.sid, { 
        status: 'in-progress',
        phone: phone,
        history: [
          { role: 'user', parts: [{ text: "Call connected." }] },
          { role: 'model', parts: [{ text: script }] }
        ]
      });

      res.json({ success: true, callSid: call.sid });
    } catch (error) {
      console.error("Error making phone call:", error);
      res.status(500).json({ error: "Failed to make phone call" });
    }
  });

  app.post("/api/twilio-webhook", async (req, res) => {
    try {
      const callSid = req.body.CallSid;
      const speechResult = req.body.SpeechResult;
      
      const callData = callResults.get(callSid);
      if (!callData) {
        return res.type('text/xml').send('<Response><Hangup/></Response>');
      }

      if (!speechResult) {
        await markCallCompleted(callSid, callData);
        return res.type('text/xml').send('<Response><Say voice="Polly.Matthew">I did not hear a response. Goodbye.</Say><Hangup/></Response>');
      }

      callData.history.push({ role: 'user', parts: [{ text: speechResult }] });

      try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await withRetry(() => ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: callData.history,
          config: {
            systemInstruction: "You are an AI insurance agent calling a carrier to get the status of a claim. Keep your responses brief, conversational, and natural for a phone call. Ask clarifying questions if needed. Once you have clearly determined the status of the claim (e.g., approved, denied, pending, paid), thank them and end your response EXACTLY with the phrase '[END CALL]'.",
            temperature: 0.3
          }
        }));

        let aiText = response.text || "I'm sorry, I didn't catch that.";
        callData.history.push({ role: 'model', parts: [{ text: aiText }] });

        if (aiText.includes('[END CALL]')) {
          aiText = aiText.replace(/\[END CALL\]/g, '').trim();
          if (!aiText) aiText = "Thank you, goodbye.";
          
          await markCallCompleted(callSid, callData);
          
          res.type('text/xml').send(`
            <Response>
              <Say voice="Polly.Matthew">${escapeXml(aiText)}</Say>
              <Hangup/>
            </Response>
          `);
        } else {
          const appUrl = getPublicUrl();
          res.type('text/xml').send(`
            <Response>
              <Gather input="speech" action="${appUrl}/api/twilio-webhook" speechTimeout="auto" timeout="10">
                <Say voice="Polly.Matthew">${escapeXml(aiText)}</Say>
              </Gather>
            </Response>
          `);
        }
      } catch (error: any) {
        console.error("Error in webhook AI generation:", error);
        await markCallCompleted(callSid, callData);
        
        const isRateLimit = error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED');
        const errorMsg = isRateLimit 
          ? "I am currently receiving too many requests and cannot process your response. Please try calling again later. Goodbye."
          : "I am experiencing technical difficulties. Goodbye.";
          
        res.type('text/xml').send(`<Response><Say voice="Polly.Matthew">${errorMsg}</Say><Hangup/></Response>`);
      }
    } catch (err) {
      console.error("Unhandled webhook error:", err);
      res.type('text/xml').send('<Response><Say voice="Polly.Matthew">An unexpected error occurred. Goodbye.</Say><Hangup/></Response>');
    }
  });

  app.post("/api/twilio-status", async (req, res) => {
    const callSid = req.body.CallSid;
    const current = callResults.get(callSid);
    
    if (callSid && current && current.status !== 'completed') {
      await markCallCompleted(callSid, current);
    }
    
    res.sendStatus(200);
  });

  app.get("/api/call-status/:callSid", (req, res) => {
    const result = callResults.get(req.params.callSid);
    res.json(result || { status: 'unknown' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
