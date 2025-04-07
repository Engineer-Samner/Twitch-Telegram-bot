const fs = require('fs');

/**
 * Логирование события. Выводит на консоль сообщение с датой и записывает в файл по пути /logs/log-гггг-мм-дд.txt
 * Сообщения разделяются пробелами
 * @param msgs Сообщения
 */
function log(...msgs) {
    const date = getDate();
    const format = `[${date.day}.${date.month}.${date.year}, ${date.hours}:${date.minutes}:${date.secs}]`;

    console.log(format, ...msgs);

    writeToFile('/logs/', `log-${date.year}-${date.month}-${date.day}.txt`, format, ...msgs);
}

/**
 * Возвращает объекты текущей даты
 */
function getDate() {
    const date = new Date();

    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();

    const hours = date.getHours();
    const minutes = date.getMinutes();
    const secs = date.getSeconds();

    delete date;

    return {
        year: year < 10 ? '0' + year : year.toString(),
        month: month < 10 ? '0' + (month + 1) : (month + 1).toString(),
        day: day < 10 ? '0' + day : day.toString(),
        hours: hours < 10 ? '0' + hours : hours.toString(),
        minutes: minutes < 10 ? '0' + minutes : minutes.toString(),
        secs: secs < 10 ? '0' + secs : secs.toString()
    }
}

/**
 * Запись в конец файла сообщение/несколько сообщений в формате UTF-8
 * @param {string} dirname Путь к папке, где будет или уже хранится файл. 
 * Папка будет создана, если его нет, в той же директории, где хранится скрипт. 
 * Если будет создаваться файл в текущей папке, передайте в качестве параметра пустую строку
 * @param {string} file Имя файла. Файл будет создан при его отсутствии
 * @param msgs Сообщения
 * @example writeToFile('/new/folder/', 'newfile.txt', 'Hello,', 'World')
*/
function writeToFile(dirname, file, ...msgs) {
    try {
        const dirPath = `.${dirname || '/'}`;
        const filePath = `${dirPath}${file}`
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        msgs.forEach(msg => fs.appendFileSync(filePath, msg.toString() + ' '));
        fs.appendFileSync(filePath, '\n');
    }
    catch (error) {
        const date = getDate();
        const format = `[${date.day}.${date.month}.${date.year}, ${date.hours}:${date.minutes}:${date.secs}] `;
        console.error(format, `❌Ошибка записи в файл: ${error}`);
        writeToFile('/logs/', `log-${date.year}-${date.month}-${date.day}.txt`, format, `\n❌Ошибка записи в файл: ${error}\n`);
    }
}

module.exports = { log, writeToFile, getDate };

if (require.main === module) {
    try {
        writeToFile('/data/others/', 'test.txt', 'Привет', 'мой', 'пирожок');
        writeToFile('/logs/', 'testlog.txt', 'Тест пройден успешно');
        writeToFile('', 'test2.txt', 'Я родился');
    }
    catch (err){
        log('Тест провален:', err.message);
    }
}
