require('dotenv').config();
const axios = require('axios');
const { log } = require('./log.js');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const TWITCH_USERNAME = process.env.TWITCH_USERNAME; // Укажите никнейм стримера
const CHECK_INTERVAL = 60 * 1000; // Проверка раз в 60 секунд

/**
 * Возвращает токен доступа
 * @param {String} clientId ID клиента. Можно его получить и секретный ключ на https://dev.twitch.tv/console/apps
 * @param {String} clientSecret cекретный ключ
 * @returns {String | undefined}
 */
async function getAccessToken(clientId, clientSecret) {
    try {
        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials'
            }
        });
        return response.data.access_token;
    }
    catch(err){
        log('Ошибка при получении токена доступа:', err.message);
        return '';
    }
}

/**
 * Возвращает ID стримера
 * @param {String} username имя стримера
 * @param {String} clientId ID клиента
 * @param {String} accessToken токен доступа 
 * @returns {Number | null}
 */
async function getUserId(username, clientId, accessToken) {
    if(!username){
        log('Ошибка получения ID пользователя: не указано имя');
        return null;
    }

    const url = `https://api.twitch.tv/helix/users?login=${username}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`
            }
        });

        return response.data.data[0]?.id;
    } 
    catch (error) {
        log('Ошибка получения ID пользователя:', error.response?.data?.message || error.message);
        return null;
    }
}

/**
 * Возвращает булево значение, true - стрим идёт, иначе false
 * @param {Number} userId ID стримера
 * @param {String} clientId ID клиента
 * @param {String} accessToken токен доступа
 */
async function streamStatus(userId, clientId, accessToken) {
    const url = `https://api.twitch.tv/helix/streams?user_id=${userId}`;

    try {
        const response = await axios.get(url,
            {
                headers: {
                    'Client-ID': clientId,
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        return response.data.data.length > 0; // Если массив не пустой, значит стрим идёт
    } catch (err) {
        log('Ошибка проверки статуса стрима:', err.message);
        return undefined;
    }
}

/**
 * Функция для получения последнего клипа за последние 24 часа
 * @param {Number} userId ID стримера 
 * @param {String} clientId ID клиента
 * @param {String} accessToken токен доступа
 */
async function getLatestClip(userId, clientId, accessToken, lastDate = (Date.now() - 24 * 60 * 60)) {
    try {
        const response = await axios.get('https://api.twitch.tv/helix/clips', {
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`
            },
            params: {
                broadcaster_id: userId,
                first: 10, // Получаем последние 10 клипов
                started_at: new Date(lastDate).toISOString(), // Начиная с последнего опубликованного клипа
            }
        });

        if (response.data.data.length === 0) {
            return undefined;
        }

        const clip = response.data.data[0];
        return {
            title: clip.title,
            url: clip.url,
            creator: clip.creator_name,
            create_date: new Date(clip.created_at).getTime()
        }
    } catch (error) {
        log('Ошибка при получении клипа:', error.message);
        return undefined;
    }
}


if (require.main === module) {
    (async () => {
        const accessToken = await getAccessToken(CLIENT_ID, CLIENT_SECRET);
        if (!accessToken) return -1;
        console.log(accessToken);
        const userId = await getUserId(TWITCH_USERNAME, CLIENT_ID, accessToken);
        console.log(userId);

        let wasLive = false;
        
        setInterval(async () => {
            const isLive = await streamStatus(userId, CLIENT_ID, accessToken);
    
            if (isLive && !wasLive) {
                console.log(`🔴 Стрим ${TWITCH_USERNAME} начался!`);
                wasLive = true;
            } else if (!isLive && wasLive) {
                console.log(`⚪ Стрим ${TWITCH_USERNAME} закончился.`);
                wasLive = false;
            }
        }, CHECK_INTERVAL);
        const date = Date.now() - 24 * 60 * 60;
        console.log(date);
        console.log(Date.now());

        const object = await getLatestClip(userId, CLIENT_ID, accessToken, date);
        console.log(object);
    })();
}

module.exports = {getAccessToken, getUserId, streamStatus, getLatestClip};