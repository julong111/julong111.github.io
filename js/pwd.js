/**
 * Password Protection Module for Audio Reverse Player
 * Handles password verification and UI toggle
 */
(function() {
    'use strict';

    function initPasswordProtection(pagePassword) {
        if (!pagePassword) return;

        const playerPanel = document.getElementById("playerPanel");
        const logPanel = document.getElementById("logPanel");
        const passwordOverlay = document.getElementById("passwordOverlay");
        const passwordInput = document.getElementById("passwordInput");
        const passwordSubmit = document.getElementById("passwordSubmit");
        const passwordError = document.getElementById("passwordError");

        if (!passwordOverlay) return;

        // 初始隐藏播放器和日志
        if (playerPanel) playerPanel.style.display = "none";
        if (logPanel) logPanel.style.display = "none";
        passwordOverlay.style.display = "block";

        function verifyPassword() {
            const input = passwordInput.value.trim();
            if (input === pagePassword) {
                passwordOverlay.style.display = "none";
                if (playerPanel) playerPanel.style.display = "block";
                if (logPanel) logPanel.style.display = "block";
                passwordError.textContent = "";
            } else {
                passwordError.textContent = "密码不正确，请联系管理员";
                passwordInput.value = "";
                passwordInput.focus();
            }
        }

        passwordSubmit.addEventListener("click", verifyPassword);
        passwordInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") verifyPassword();
        });
        passwordInput.focus();
    }

    // 暴露给全局，供页面初始化调用
    window.AudioReversePwd = { init: initPasswordProtection };
})();