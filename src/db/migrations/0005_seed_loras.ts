/* The two lightx2v turbo LoRAs from the handoff, so a fresh studio renders at
   8 steps out of the box. INSERT OR IGNORE keeps user edits. */
export default String.raw`
INSERT OR IGNORE INTO loras (id, name, kind, filename, hf_url, trigger_words, default_strength, steps_hint, workflows_json, notes, created_at, updated_at) VALUES
  ('lora_h3_turbo_fl2v', 'H3 turbo 8-step (fl2v)', 'speed', 'minimax_h3_fl2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors',
   'https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors',
   '', 1.0, 8, '["T2VA","I2VA","FL2VA"]', 'lightx2v turbo LoRA for the fl2va base model (text / image / first-last frame). Strength 1.0, 8 steps, euler/simple, sigma shift 6.0 video / 3.0 audio.', 1762300000000, 1762300000000),
  ('lora_h3_turbo_ref2v', 'H3 turbo 8-step (ref2v)', 'speed', 'minimax_h3_ref2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors',
   'https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_ref2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors',
   '', 1.0, 8, '["R2VA"]', 'lightx2v turbo LoRA for the ref2va base model (reference-to-video). Strength 1.0, 8 steps, ref_image_size match.', 1762300000000, 1762300000000);
`;
