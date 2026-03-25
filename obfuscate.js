const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

// On lit maintenant le code depuis le fichier source clair
const sourcePath = path.join(__dirname, 'public', 'script_src.js');
const targetPath = path.join(__dirname, 'public', 'script.js');

if (!fs.existsSync(sourcePath)) {
    console.error('Erreur: public/script_src.js introuvable !');
    process.exit(1);
}

const scriptContent = fs.readFileSync(sourcePath, 'utf8');

const obfuscated = JavaScriptObfuscator.obfuscate(scriptContent, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,
    numbersToExpressions: true,
    simplify: true,
    stringArrayThreshold: 1,
    splitStrings: true,
    splitStringsChunkLength: 5,
    unicodeEscapeSequence: true
});

fs.writeFileSync(targetPath, obfuscated.getObfuscatedCode());
console.log('✅ script.js a été mis à jour et obfuscé avec succès depuis script_src.js !');
