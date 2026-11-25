import arabic from '../electron/ar.json';

export let languageState: LanguageState = { preference: 'system', language: 'en' };
export function applyLanguage(state: LanguageState) {
  languageState = state;
  document.documentElement.lang = state.language;
  document.documentElement.dir = state.language === 'ar' ? 'rtl' : 'ltr';
}
export function t(key: string, ...values: unknown[]): string {
  const template = languageState.language === 'ar' && Object.hasOwn(arabic, key) ? (arabic as Record<string, string>)[key] ?? key : key;
  return values.length ? template.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)])) : template;
}
