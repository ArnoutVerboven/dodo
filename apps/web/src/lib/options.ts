import { isLocalModel, LOCAL_MODEL } from '@dodo/core';

/**
 * Models offered in the UI. Every Gemini model here must also be priced in @dodo/budget; the
 * local model runs on your Mac, outside the budget (docs/LOCAL_MODEL.md).
 */
export const MODEL_OPTIONS: { value: string; label: string; title?: string }[] = [
  { value: 'auto', label: 'Auto', title: 'A small model picks one for each task' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
  { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: LOCAL_MODEL, label: 'Local model', title: 'On your Mac, no budget used' },
];

/**
 * The settings patch for picking a device. The local model runs only on a Mac, so picking Remote
 * while the local model applies (picked here or inherited) switches the model: to the inherited
 * model when that is a cloud one, else Auto.
 */
export function pickDevice(
  device: string,
  value: { model?: string },
  inherited: { model?: string } = {},
): { device: string; model?: string } {
  if (device !== 'gcp' || !isLocalModel(value.model ?? inherited.model)) return { device };
  const model = inherited.model && !isLocalModel(inherited.model) ? undefined : 'auto';
  return { device, model };
}
