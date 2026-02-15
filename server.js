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
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
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
const DEBUG = process.env.DEBUG === 'true';
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 2);
const GLOBAL_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 12000);

const parsed = EnvelopeSchema.safeParse(req.body);
if (!parsed.success) {
return res.status(400).json({
error: 'invalid_envelope',
details: parsed.error.flatten(),
});
}

const envelope = parsed.data;

// Timeout global (evita worker travar)
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);

// helper: safe JSON.parse
const safeJsonParse = (s) => {
try {
return JSON.parse(s);
} catch {
return null;
}
};

try {
// ======================================================
// 1) BUSCAR REGRAS DA CLÍNICA (SEM HARDCODE)
// ======================================================
const { data: settings, error: settingsErr } = await supabase
.from('clinic_settings')
.select('*')
.eq('clinic_id', envelope.clinic_id)
.maybeSingle();

if (settingsErr) throw settingsErr;
if (!settings) {
log.warn(
{ clinic_id: envelope.clinic_id, correlation_id: envelope.correlation_id },
'clinic_settings_not_found_using_defaults'
);
}

const clinicRules = settings ?? {
clinic_id: envelope.clinic_id,
allow_prices: false,
timezone: 'America/Cuiaba',
business_hours: {},
policies_text: '',
};

// ======================================================
// 2) RETRIEVAL SIMPLES DA KB (RAG básico)
// (MVP: pega até 8 itens da clinic_kb; depois você melhora com busca)
// ======================================================
const { data: kbRows, error: kbErr } = await supabase
.from('clinic_kb')
.select('title, content')
.eq('clinic_id', envelope.clinic_id)
.limit(8);

if (kbErr) throw kbErr;

const kbContext = (kbRows ?? [])
.map((r) => `• ${r.title}: ${r.content}`)
.join('\n');

// ======================================================
// 3) TOOLS — schemas rígidos (additionalProperties:false)
// ======================================================

const tools = [
{
type: 'function',
name: 'extract_intent',
strict: true,
description:
'Classifica intenção (2 níveis) e extrai slots estruturados. Não escreve resposta ao usuário.',
parameters: {
type: 'object',
additionalProperties: false,
properties: {
intent_group: {
type: 'string',
enum: [
'scheduling',
'procedures',
'clinical',
'billing',
'logistics',
'results',
'other',
],
},
intent: { type: 'string' },

// Slots explícitos (união dos principais por vertical)
slots: {
type: 'object',
additionalProperties: false,
properties: {
// comuns
patient_name: { type: 'string' },
specialty_or_reason: { type: 'string' },
preferred_date_text: { type: 'string' },
preferred_time_text: { type: 'string' },
time_window: {
type: 'string',
enum: [
'morning',
'afternoon',
'evening',
'after_18',
'before_10',
'any',
'unknown',
],
},
doctor_preference: { type: 'string' },
unit_preference: { type: 'string' },

// estética/procedimentos
procedure_name: { type: 'string' },
procedure_area: { type: 'string' },
goal: { type: 'string' },
price_request: { type: 'boolean' },

// clínica geral
symptom_summary: { type: 'string' },
duration: { type: 'string' },
severity: { type: 'string' },
red_flags_present: {
type: 'array',
items: { type: 'string' },
},
comorbidities: { type: 'string' },
current_meds: { type: 'string' },
requested_care_type: { type: 'string' },

// exames/resultados
test_type: { type: 'string' },
result_status: { type: 'string' },
collection_date: { type: 'string' },
fasting_question: { type: 'boolean' },
abnormal_values_mentioned: { type: 'string' },
next_step_request: { type: 'string' },
},
required: [],
},

missing_fields: {
type: 'array',
items: { type: 'string' },
},

confidence: { type: 'number', minimum: 0, maximum: 1 },
},
required: ['intent_group', 'intent', 'confidence'],
},
},

{
type: 'function',
name: 'decide_next_action',
strict: true,
description:
'Decide o próximo passo (policy), com base no extracted + regras + KB. Retorna mensagem curta e ações sugeridas.',
parameters: {
type: 'object',
additionalProperties: false,
properties: {
decision_type: {
type: 'string',
enum: ['ask_missing', 'block_price', 'handoff', 'proceed'],
},
message: { type: 'string' },
actions: {
type: 'array',
items: {
type: 'object',
additionalProperties: false,
properties: {
type: { type: 'string' },
payload: { type: 'object' },
},
required: ['type'],
},
},
confidence: { type: 'number', minimum: 0, maximum: 1 },
},
required: ['decision_type', 'message'],
},
},
];

// ======================================================
// 4) FEW-SHOTS (curto, só para calibrar)
// ======================================================
const fewShots = `
Exemplo 1:
Usuário: "Quero marcar consulta amanhã de manhã"
extract_intent => {"intent_group":"scheduling","intent":"schedule_new","slots":{"time_window":"morning","preferred_date_text":"amanhã"},"missing_fields":["patient_name","specialty_or_reason"],"confidence":0.92}

Exemplo 2:
Usuário: "Quanto custa botox?"
extract_intent => {"intent_group":"billing","intent":"procedure_pricing_request","slots":{"procedure_name":"botox","price_request":true},"missing_fields":[],"confidence":0.95}
`.trim();

// ======================================================
// 5) LOOP CONTROLADO (máx 2 steps por padrão)
// ======================================================
let step = 0;
let extracted = null;
let decided = null;

// STEP 0: extract_intent (FORÇADO)
if (step < MAX_STEPS) {
const extraction = await openai.responses.create({
model: OPENAI_MODEL,
instructions: [
'Você é um classificador/estruturador. Sua única saída é chamar a tool extract_intent.',
'Não gere texto para o usuário.',
'Não invente dados. Se incerto, mantenha confidence baixa.',
'Taxonomia: intent_group + intent.',
'Use os slots definidos.',
'Contexto KB (referência de domínio):',
kbContext || 'SEM KB',
'',
fewShots,
].join('\n'),
input: envelope.message_text,
tools: [tools[0]],
tool_choice: { type: 'function', name: 'extract_intent' },
signal: controller.signal,
});

const call = extraction.output?.find(
(o) => o.type === 'tool_call' && o.name === 'extract_intent'
);

const parsedArgs = call?.arguments ? safeJsonParse(call.arguments) : null;

if (!parsedArgs) {
return res.json({
correlation_id: envelope.correlation_id,
final_message:
'Entendi. Só para eu te ajudar: você quer marcar, remarcar ou cancelar uma consulta?',
actions: [],
debug: DEBUG ? { note: 'no_extract_tool_call' } : undefined,
});
}

extracted = parsedArgs;
step++;
}

// ======================================================
// 6) CONFIDENCE GUARD (backend decide quando pedir clarificação)
// ======================================================
if (!extracted || extracted.confidence < 0.6) {
clearTimeout(timeout);
return res.json({
correlation_id: envelope.correlation_id,
final_message:
'Só para confirmar: você quer marcar, remarcar, cancelar ou tirar uma dúvida?',
actions: [],
debug: DEBUG ? { extracted } : undefined,
});
}

// ======================================================
// 7) STEP 1: decide_next_action (FORÇADO)
// ======================================================
if (step < MAX_STEPS) {
const decision = await openai.responses.create({
model: OPENAI_MODEL,
instructions: [
'Você decide o próximo passo (policy). Sua única saída é chamar decide_next_action.',
'Não invente agenda. Não confirme horário.',
`Regra crítica: allow_prices=${clinicRules.allow_prices}.`,
'Se o paciente pedir preço e allow_prices=false: decision_type=block_price.',
'Se faltar dado essencial: decision_type=ask_missing com pergunta mínima.',
'Use KB quando relevante (sem inventar).',
'Responda em pt-BR e mensagem curta.',
'KB:',
kbContext || 'SEM KB',
].join('\n'),
input: JSON.stringify({ extracted }),
tools: [tools[1]],
tool_choice: { type: 'function', name: 'decide_next_action' },
signal: controller.signal,
});

const call = decision.output?.find(
(o) => o.type === 'tool_call' && o.name === 'decide_next_action'
);

const parsedArgs = call?.arguments ? safeJsonParse(call.arguments) : null;

if (!parsedArgs) {
decided = {
decision_type: 'ask_missing',
message:
'Perfeito. Me diga seu nome completo e o melhor dia/horário (manhã/tarde/noite).',
actions: [{ type: 'log' }],
};
} else {
decided = parsedArgs;
}

step++;
}

// ======================================================
// 8) VALIDAÇÃO BACKEND (NÃO deixar o modelo mandar sem validação)
// ======================================================
if (
extracted.intent_group === 'billing' &&
clinicRules.allow_prices === false
) {
decided = {
decision_type: 'block_price',
message:
'Por aqui não informamos valores. Posso agendar uma avaliação — me diga seu nome e o melhor dia/horário 🙂',
actions: [{ type: 'log' }],
confidence: 1,
};
}

// ======================================================
// 9) LOG ESTRUTURADO (agent_logs)
// ======================================================
// Falha de log NÃO deve quebrar a resposta
try {
await supabase.from('agent_logs').insert({
clinic_id: envelope.clinic_id,
correlation_id: envelope.correlation_id,
intent_group: extracted.intent_group,
intent: extracted.intent,
confidence: extracted.confidence,
decision_type: decided?.decision_type || null,
latency_ms: Date.now() - started,
});
} catch (e) {
// opcional: log local (pino)
log.warn({ err: String(e) }, 'agent_logs_insert_failed');
}

clearTimeout(timeout);

return res.json({
correlation_id: envelope.correlation_id,
final_message: decided.message,
actions: decided.actions ?? [],
debug: DEBUG
? { extracted, decided, kb_hits: (kbRows ?? []).length, latency_ms: Date.now() - started }
: undefined,
});
} catch (err) {
clearTimeout(timeout);

const errName = err?.name || 'UnknownError';
const errMessage = err?.message || String(err);
log.error(
{
err_name: errName,
err_message: errMessage,
correlation_id: envelope.correlation_id,
clinic_id: envelope.clinic_id,
},
'process_error'
);

const isTimeout = String(err?.name || '').toLowerCase().includes('abort');

return res.status(200).json({
correlation_id: envelope.correlation_id,
final_message: isTimeout
? 'Demorei um pouco para responder. Pode repetir sua mensagem, por favor? 🙏'
: 'Tive uma instabilidade agora. Pode repetir sua mensagem em 1 minuto?',
actions: [{ type: 'log', payload: { event: 'agent_error' } }],
debug: DEBUG
? { error_message: errMessage, error_name: errName }
: undefined,
});
}
});

app.listen(PORT, () => {
  log.info({ port: PORT }, 'agent-service listening');
});
