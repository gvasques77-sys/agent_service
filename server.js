import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import pino from 'pino';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const log = pino({
  transport: { target: 'pino-pretty' },
});

// ENV
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!OPENAI_API_KEY) log.warn('OPENAI_API_KEY nÃ£o definido (coloque no .env)');
if (!SUPABASE_URL) log.warn('SUPABASE_URL nÃ£o definido (coloque no .env)');
if (!SUPABASE_SERVICE_ROLE_KEY) log.warn('SUPABASE_SERVICE_ROLE_KEY nÃ£o definido (coloque no .env)');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY || 'missing' });

const supabase = createClient(
  SUPABASE_URL || 'missing',
  SUPABASE_SERVICE_ROLE_KEY || 'missing',
  { auth: { persistSession: false } }
);

// Envelope que vem do seu Worker (n8n)
const EnvelopeSchema = z.object({
  correlation_id: z.string().min(6),
  clinic_id: z.string().min(1),
  from: z.string().min(5),
  message_text: z.string().min(1),
  phone_number_id: z.string().optional(),
  received_at_iso: z.string().optional(),
});

app.get('/health', (req, res) => {
  return res.json({ ok: true, service: 'agent-service' });
});

app.post('/process', async (req, res) => {
  const started = Date.now();

  const parsed = EnvelopeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_envelope',
      details: parsed.error.flatten(),
    });
  }
  const envelope = parsed.data;

  try {
    // 1) Buscar regras da clÃ­nica (MVP sem agenda)
    const { data: settings, error: settingsErr } = await supabase
      .from('clinic_settings')
      .select('*')
      .eq('clinic_id', envelope.clinic_id)
      .maybeSingle();

    if (settingsErr) throw settingsErr;

    const clinicRules = settings ?? {
      clinic_id: envelope.clinic_id,
      timezone: 'America/Cuiaba',
      allow_prices: false,
      business_hours: {
        mon_fri: '08:00-12:00,13:00-18:00',
        sat: '08:00-12:00',
        sun: 'closed',
      },
      policies_text:
        'Se allow_prices=false, nÃ£o informar preÃ§os. Focar em triagem e coleta de dados para agendamento.',
    };

    // 2) Tool Ãºnica (MVP): extrair intenÃ§Ã£o e dados
    const tools = [
      {
        type: 'function',
        name: 'extract_intent',
        description:
          'Extrai intenÃ§Ã£o e dados estruturados de uma mensagem do paciente para secretÃ¡ria de clÃ­nica.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            intent: {
              type: 'string',
              enum: ['schedule', 'reschedule', 'cancel', 'confirm', 'info', 'prices', 'other'],
            },
            patient_name: { type: 'string' },
            specialty: { type: 'string' },
            preferred_date: { type: 'string' },
            preferred_time: { type: 'string' },
            missing_fields: {
              type: 'array',
              items: { type: 'string' },
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['intent', 'missing_fields', 'confidence'],
        },
      },
    ];

    // 3) Chamar OpenAI (tool calling)
    const response = await openai.responses.create({
      model: 'gpt-5.2',
      instructions: [
        'VocÃª Ã© uma secretÃ¡ria inteligente de clÃ­nica no WhatsApp.',
        'Seja humana, objetiva e eficiente. Evite perguntas desnecessÃ¡rias.',
        'NÃ£o invente agenda (nÃ£o existe agenda no sistema).',
        `Regras dinÃ¢micas: allow_prices=${clinicRules.allow_prices}; business_hours=${JSON.stringify(clinicRules.business_hours)}.`,
        `Politicas: ${String(clinicRules.policies_text || '')}`,
        'Se o paciente pedir preÃ§os e allow_prices=false, negue com educaÃ§Ã£o e ofereÃ§a agendar avaliaÃ§Ã£o.',
        'Responda em pt-BR.'
      ].join('\\n'),
      input: envelope.message_text,
      tools,
      tool_choice: { type: 'function', name: 'extract_intent' },
    });

    const toolCall = response.output?.find((o) => o.type === 'tool_call');
    const extracted = toolCall?.arguments ? JSON.parse(toolCall.arguments) : null;

    if (!extracted) {
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message:
          'Entendi. Para eu te ajudar direitinho, vocÃª pode me dizer seu nome e se vocÃª quer marcar, remarcar ou cancelar uma consulta?',
        actions: [],
        debug: { note: 'no_tool_call', latency_ms: Date.now() - started },
      });
    }

    // 4) Regra de preÃ§o
    if (extracted.intent === 'prices' && clinicRules.allow_prices === false) {
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message:
          'Sobre valores: por aqui a gente nÃ£o informa preÃ§os. Mas posso te ajudar a agendar uma avaliaÃ§Ã£o â€” me diga seu nome e qual melhor dia/horÃ¡rio. ðŸ™‚',
        actions: [{ type: 'log', event: 'prices_blocked', extracted }],
        debug: { extracted, latency_ms: Date.now() - started },
      });
    }

    // 5) Pedir o que falta (poupando etapas)
    const missing = extracted.missing_fields ?? [];
    const askPieces = [];

    // OBS: o modelo pode nÃ£o preencher missing_fields perfeitamente no comeÃ§o.
    // vocÃª vai ajustar depois com testes.
    if (missing.includes('patient_name')) askPieces.push('seu nome');
    if (missing.includes('specialty')) askPieces.push('a especialidade (ou o motivo da consulta)');
    if (missing.includes('preferred_date')) askPieces.push('o melhor dia');
    if (missing.includes('preferred_time')) askPieces.push('o melhor horÃ¡rio (manhÃ£/tarde/noite)');

    const ask = askPieces.length
      ? `Só me diga ${askPieces.join(', ')} e eu já sigo com você.`
      : 'Perfeito. Me diga seu nome e o melhor dia/horÃ¡rio e eu jÃ¡ sigo com vocÃª.';

    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: ask,
      actions: [
        { type: 'upsert_patient', patient_name: extracted.patient_name ?? null },
        { type: 'log', event: 'intent_extracted', extracted },
      ],
      debug: { extracted, latency_ms: Date.now() - started },
    });
  } catch (err) {
    log.error({ err }, 'agent_process_error');
    return res.status(500).json({
      correlation_id: envelope.correlation_id,
      final_message:
        'Tive uma instabilidade aqui. Pode repetir sua mensagem em 1 minuto, por favor? ðŸ™',
      actions: [{ type: 'log', event: 'agent_error', err: String(err?.message ?? err) }],
    });
  }
});

app.listen(PORT, () => {
  log.info({ port: PORT }, 'agent-service listening');
});
