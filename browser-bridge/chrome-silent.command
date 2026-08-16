#!/bin/bash
# Запуск Chrome с флагом --silent-debugger-extension-api:
# жёлтая плашка «Инструмент X запустил отладку этого браузера» не появляется.
# ВАЖНО: Chrome должен быть полностью закрыт, иначе флаг не применится.
# Вкладки восстановятся автоматически (Chrome восстанавливает сессию).
echo "Закрываю Chrome (сессия вкладок восстановится при следующем запуске)..."
osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null
sleep 3
open -a "Google Chrome" --args --silent-debugger-extension-api
echo "Chrome запущен с флагом --silent-debugger-extension-api"
