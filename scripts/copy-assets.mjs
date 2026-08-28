/** The one non-TypeScript file the build has to carry: the terminal's stylesheet. */
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist/react', { recursive: true });
copyFileSync('src/react/terminal.css', 'dist/react/terminal.css');
console.log('copied src/react/terminal.css → dist/react/terminal.css');
