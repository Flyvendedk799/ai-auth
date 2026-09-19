const fs = require('fs');
let content = fs.readFileSync('src/registry/errors.ts', 'utf8');
content = content.replace("if (provider === 'gemini-cli') return 'gemini';", "if (provider === 'gemini-cli') return 'agy';");
fs.writeFileSync('src/registry/errors.ts', content);
