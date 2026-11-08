/* LoRAs for Qwen-Image 2.1 (the base model, Canvas on the GPU pod): ChatR
   Labs' Omni v0.1, with its card's settings. A seed is recorded in
   studio_seeds so a LoRA the user deletes stays deleted; the Studio also
   applies this seed on first use (repo.ts), so a deploy works before the
   file has been run on D1. INSERT OR IGNORE keeps user edits. */
export const QWEN_LORA_SEED = "0017_seed_qwen_loras";
export const QWEN_LORA_SQL = String.raw`INSERT OR IGNORE INTO loras (id, name, kind, filename, hf_url, trigger_words, default_strength, steps_hint, workflows_json, notes, base_model, params_json, created_at, updated_at) VALUES ('lora_chatr_omni_v01', 'ChatR Omni v0.1 (uncensored)', 'effect', 'chatrlabs-omni-lora-v0.1-bf16.safetensors', 'https://huggingface.co/chatrlabs/Qwen-Image-2.1-Uncensored-Omni-LoRA-v0.1/resolve/main/chatrlabs-omni-lora-v0.1-bf16.safetensors', '', 1.0, NULL, '[]', 'ChatR Labs'' rank-128 adapter for Qwen-Image 2.1 (base, not Turbo): text-to-image and editing with 1–3+ references, no prompt filter or safety checker. Card settings: strength 1.0, 35 steps, true CFG 5 with a single-space negative prompt, about 1 MP. 18+: shown only once the user has unlocked 18+, never with an uploaded picture. Qwen Research License: non-commercial only. Diffusers/PEFT keys — if ComfyUI logs "lora key not loaded" the adapter did not apply.', 'qwen-image-2.1', '{"steps":35,"cfg":5,"strength":1}', 1794200000000, 1794200000000)`;

export default String.raw`
CREATE TABLE IF NOT EXISTS studio_seeds (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
${QWEN_LORA_SQL};
INSERT OR IGNORE INTO studio_seeds (name, applied_at) VALUES ('0017_seed_qwen_loras', 1794200000000);
`;
