(function () {
  'use strict';

  const tokenKey = 'cocClanTrackerToken';
  const notice = document.querySelector('#notice');
  const showNotice = (message, error) => {
    if (!notice) return;
    notice.textContent = message;
    notice.className = `notice show${error ? ' error' : ''}`;
  };

  async function request(path, options) {
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options && options.headers) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || (data.data && data.data.error) || 'An unexpected server error occurred.');
    }
    return data;
  }

  const formData = (form) => Object.fromEntries(new FormData(form).entries());

  document.querySelectorAll('.password-toggle').forEach((passwordToggle) => {
    const passwordInput = passwordToggle.parentElement.querySelector('input');
    if (passwordInput) {
      passwordToggle.addEventListener('click', () => {
        const isVisible = passwordInput.type === 'text';
        passwordInput.type = isVisible ? 'password' : 'text';
        passwordToggle.textContent = isVisible ? 'Show' : 'Hide';
        passwordToggle.setAttribute('aria-label', isVisible ? 'Show password' : 'Hide password');
      });
    }
  });

  async function submitForm(selector, path, successMessage, onSuccess) {
    const form = document.querySelector(selector);
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await request(path, { method: 'POST', body: JSON.stringify(formData(event.target)) });
        showNotice(result.simulatedEmail ? `${successMessage} Code: ${result.simulatedEmail.code}` : successMessage);
        if (onSuccess) onSuccess();
      } catch (error) {
        showNotice(error.message, true);
      }
    });
  }

  submitForm('#forgot-form', '/auth/forgot-password', 'Reset code generated.');
  submitForm('#reset-form', '/auth/reset-password', 'Password reset successfully.');

  const register = document.querySelector('#register-form');
  if (register) {
    register.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await request('/auth/register', {
          method: 'POST',
          body: JSON.stringify(formData(event.target))
        });
        showNotice(`Confirmation code (simulated email): ${result.simulatedEmail.code}`);
      } catch (error) {
        showNotice(error.message, true);
      }
    });
  }

  const confirm = document.querySelector('#confirm-form');
  if (confirm) {
    confirm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await request('/auth/confirm', {
          method: 'POST',
          body: JSON.stringify(formData(event.target))
        });
        showNotice('Email confirmed. You can now log in.');
      } catch (error) {
        showNotice(error.message, true);
      }
    });
  }

  const login = document.querySelector('#login-form');
  if (login) {
    login.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await request('/auth/login', {
          method: 'POST',
          body: JSON.stringify(formData(event.target))
        });
        localStorage.setItem(tokenKey, result.data.token);
        window.location.href = '/';
      } catch (error) {
        showNotice(error.message, true);
      }
    });
  }
}());
