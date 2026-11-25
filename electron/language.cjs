const arabic = require('./ar.json');

function resolveLanguage(preference, preferred) {
  if (preference === 'ar' || preference === 'en') return preference;
  for (const locale of preferred) {
    const base = locale.toLowerCase().split(/[-_]/)[0];
    if (base === 'ar' || base === 'en') return base;
  }
  return 'en';
}

function menuLanguage(items, language) {
  if (language !== 'ar') return items;
  const roleLabels = { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All', quit: 'Quit', togglefullscreen: 'Toggle Full Screen' };
  return items.map(item => {
    const key = item.label || roleLabels[item.role];
    return { ...item, ...(key && { label: arabic[key] || key }), ...(item.submenu && { submenu: menuLanguage(item.submenu, language) }) };
  });
}
module.exports = { resolveLanguage, menuLanguage };
