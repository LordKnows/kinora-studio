/* LoRAs carry the settings their card recommends (models.ts): a speed
   LoRA's steps, sampler, scheduler and shift, any LoRA's strength range,
   and the model family it was trained for. The Studio also adds these
   columns on first use; a second ALTER answers "duplicate column". */
export default String.raw`
ALTER TABLE loras ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE loras ADD COLUMN base_model TEXT NOT NULL DEFAULT 'minimax-h3';
`;
