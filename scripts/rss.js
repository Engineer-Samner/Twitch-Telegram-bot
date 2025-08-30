const axios = require('axios');
const { Input } = require('telegraf');

const { log } = require('./log.js');

/**
 * Парсит телеграм-канале и вытаскивает последний выложенный пост
 * @param {string} channelusername имя канала (например, \@rssbridge или rssbridge)
 * @param {string} domain домен или адрес сервера. По умолчанию - rss-bridge.org/bridge01
 * @param {Number} cache_timeout частота обновления кэша в секундах
 * @returns
 */
async function parseTelegramPost(channelname, domain = 'rss-bridge.org/bridge01', cache_timeout = 60) {
    if (!channelname)
        throw Error('имя канала не задано');

    try {
        const name = channelname.replace('@', '');
        const url = `http://${domain}/?action=display&username=${name}&bridge=TelegramBridge&_cache_timeout=${cache_timeout}&format=Json`;

        const response = await axios.get(url);
        const data = response.data;
        const post = data.items[0];
        const desc = post.content_html || '';
        const link = post.url || '';
        const urls = [...await parseVideoTelegram(desc), ...await parseImageTelegram(desc)];
        const text = await parseTextTelegram(desc, link);
        return {
            link: link,
            media: urls,
            text: text
        }
    } catch (error) {
        log('❌ Ошибка при получении поста из телеграм-канала', ':', error.message);
        return undefined;
    }
}

async function getMedia(media) {
    try {
        let urls = [];
        let res;

        if(media.length === 0) return [];

        for (let mediaUrl of media) {
            res = await axios.get(mediaUrl[1], { responseType: 'stream' });
            urls.push([mediaUrl[0], Input.fromReadableStream(res.data)]);
        }

        return urls;
    }
    catch (error) {
        log('❌Ошибка при получении медиа:', error.message);
        return [];
    }
}

/**
 * Извлекает из содержимого поста все видео
 * @param {*} postText содержимое поста из description
 */
async function parseVideoTelegram(postText) {
    try {
        const urls = [];
        let match;

        // Ищем видео
        const vidTagRegex = /<video\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
        while ((match = vidTagRegex.exec(postText)) !== null) {
            urls.push(['video', match[1]]);
        }

        const vidTagSrcRegex = /<source\s+src=["'](.*?)["'] type=["']video\/mp4["']>/gi;
        while ((match = vidTagSrcRegex.exec(postText)) !== null) {
            urls.push(['video', match[1]]);
        }

        return urls;
    }
    catch (error) {
        log('❌Ошибка при парсинге URL-адреса видео:', error.message);
        return undefined;
    }
}

/**
 * Извлекает из содержимого поста все фото
 * @param {*} postText содержимое поста из description
 */
async function parseImageTelegram(postText) {
    try {
        const urls = [];
        let match;

        // Ищем изображения
        const imgTagRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
        while ((match = imgTagRegex.exec(postText)) !== null) {
            urls.push(['photo', match[1]]);
        }

        console.log(urls);

        return urls;
    }
    catch (error) {
        log('❌Ошибка при парсинге URL-адреса фото:', error.message);
        return undefined
    }
}

/**
 * Извлекает из содержимого поста текст.
 * Возвращает текст со всеми тегами, если такого имеется, в противном случае обычный текст
 * @param {*} postText содержимое поста из description
 * @param {string} postLink ссылка на пост, если необходимо указать источник
 * @returns 
 */
async function parseTextTelegram(postText, postLink = '') {
    try {
        // if(postText.search(/<div\sclass="message_media_not_supported">/g) !== -1)
        //     return `Новый пост: ${postLink}`;

        let text = postText.replace(/<br\/?>/g, '\n'); // Замена тега br на перенос строки

        // Извлекаем текст со всеми тегами внутри div
        const pMatches = text.match(/<div\sclass="tgme_widget_message_text\sjs-message_text"\sdir="auto">.*?<\/div>/gs);
        const pText = pMatches ? pMatches.map(match => match.replace(/<\/?div.*?>/g, '').replace(/<\/?(i|b)(\sclass="emoji".*?)?>/g, '')) : '';

        // Удаляем все HTML-теги
        text = text.replace(/<\/?.*?>/g, '');

        // Если был тег <div>, используем, иначе очищенный текст
        text = pText || text;

        if (postLink !== '')
            text += `\n\n🔗 Источник: ${postLink}`;

        return text;
    }
    catch (error) {
        log('❌Ошибка при парсинге текста:', error.message);
        return undefined;
    }
}

module.exports = { parseTelegramPost, getMedia };

if (require.main === module) {
    (async () => {
        try {
            const object = await parseTelegramPost('dvachannel', '127.0.0.1:3000');
        } catch (error) {
            log('❌Непредвиденная ошибка:', error.message);
        }
    })();
}