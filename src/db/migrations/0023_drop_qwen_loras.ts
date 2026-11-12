/* Qwen-Image 2.1 (Turbo and base) and Qwen-Image-Edit 2509 left the GPU pod:
   the LoRA the Studio seeded for the base model (0017, ChatR Omni v0.1) goes
   with them. A LoRA the user added for those models stays in the library —
   no model loads it, and it can be deleted on the LoRAs page. Recorded in
   studio_seeds; the Studio also applies this on first use (repo.ts), so a
   deploy works before the file has been run on D1. */
export const DROP_QWEN_LORA_SEED = "0023_drop_qwen_loras";
export const DROP_QWEN_LORA_SQL = "DELETE FROM loras WHERE id = 'lora_chatr_omni_v01'";

export default String.raw`
CREATE TABLE IF NOT EXISTS studio_seeds (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
${DROP_QWEN_LORA_SQL};
INSERT OR IGNORE INTO studio_seeds (name, applied_at) VALUES ('0023_drop_qwen_loras', 1794450000000);
`;
