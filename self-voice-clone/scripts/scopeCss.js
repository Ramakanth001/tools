const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');

const cssPath = path.resolve(__dirname, '..', 'src', 'ui', 'selfVoiceClone.css');
const prefix = '.self-voice-clone-tool';
const root = postcss.parse(fs.readFileSync(cssPath, 'utf8'));

root.walkRules((rule) => {
  rule.selectors = rule.selectors.flatMap((selector) => {
    const clean = selector.trim();
    if (clean === '*') return [prefix, `${prefix} *`];
    if (clean === ':root' || clean === 'body') return [prefix];
    if (clean === 'main') return [`${prefix} .self-voice-clone-main`];
    if (clean.startsWith(prefix)) return [clean];
    return [`${prefix} ${clean}`];
  });
});

fs.writeFileSync(cssPath, root.toString());
