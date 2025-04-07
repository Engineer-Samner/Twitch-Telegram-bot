# Telegram Bot

Простой Telegram-бот на Node.js с использованием [Telegraf](https://telegraf.js.org/).

## 🚀 Туториал для чайников

### Установка бота на Windows

Скачиваем репозиторий, запускаем файл start.bat и следуем инструкциям из терминала

### Установка бота на Ubuntu Server/Debian
Минимальные требования VPS:
0.5 RAM
1 ядро 2.2 ГГц
10 GB HDD

VPS можно найти за 140 руб./мес.
1. После установки ОС делаем следующее

```bash
sudo apt-get update && sudo apt upgrade
sudo apt-get install git npm
git clone https://github.com/Engineer-Samner/Twitch-Telegram-bot.git
```

2. Установка зависимости:

```bash
cd Twitch-Telegram-bot
npm install
```

2. Указать токен бота:
- Необходимо создать файл `token.txt` и вставить туда токен, полученный от [BotFather](https://t.me/BotFather).
```bash
echo ТОКЕН_от_BotFather > token.txt
```
- При первом запуске скрипт сам создаст `.env` и перенесёт токен в него.

3. Запуск бота:

```bash
node index.js
```

4. Следуем указаниям, выводимые на терминал

## Установка своего RSS-bridge

Если необходимо проверять новые посты в телеграм-канале раз в 1 минуту, устанавливаем следующий [репозиторий](https://github.com/RSS-Bridge/rss-bridge/tree/master) по [этой](https://gitmemories.com/RSS-Bridge/rss-bridge) инструкции
Нам достаточно будет выполнить п. "Install with git" и "Install by locally building the image"

Далее копируем файл config.default.ini.php и делаем изменения в скопированном файле

```bash
cat config.default.ini.php > config.ini.php
```

Меняем строку
``` php
custom_timeout = false
```
на
``` php
custom_timeout = true
```

Меняем в настройках официальный адрес RSS-bridge на свой. Теперь новые посты будут публиковаться максимум 1 минуту с момента публикования

## ⚙️ Настройки

Все параметры задаются через `.env`. Пример настроек есть в `.env.example`.

## 📝 Лицензия

Проект распространяется под лицензией MIT.  
Можно свободно использовать, копировать, изменять и распространять — без ограничений.
