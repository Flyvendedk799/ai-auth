const fs = require('fs');
let content = fs.readFileSync('src/registry/errors.test.ts', 'utf8');
content = content.replace("toMatch(/run \\`gemini\\`/i)", "toMatch(/run \\`agy\\`/i)");
fs.writeFileSync('src/registry/errors.test.ts', content);
