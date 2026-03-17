const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, 'public', 'script.js');
const scriptContent = fs.readFileSync(scriptPath, 'utf8');

const obfuscationResult = JavaScriptObfuscator.obfuscate(scriptContent, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,
    numbersToExpressions: true,
    simplify: true,
    stringArrayThreshold: 1,
    splitStrings: true,
    splitStringsChunkLength: 5,
    unicodeEscapeSequence: false
});

fs.writeFileSync(scriptPath, obfuscationResult.getObfuscatedCode());
console.log('Script obfuscated successfully.');
