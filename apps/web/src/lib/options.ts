/** Models offered in the UI. Every model here must also be priced in @dodo/budget. */
export const MODEL_OPTIONS = [
  { value: 'auto', label: 'Auto (small model decides)' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite (cheapest)' },
  { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (default)' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (older)' },
];
