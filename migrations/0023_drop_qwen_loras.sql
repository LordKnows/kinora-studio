CREATE TABLE IF NOT EXISTS studio_seeds (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
DELETE FROM loras WHERE id = 'lora_chatr_omni_v01';
INSERT OR IGNORE INTO studio_seeds (name, applied_at) VALUES ('0023_drop_qwen_loras', 1794450000000);
