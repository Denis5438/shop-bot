const fs = require('fs');
const path = require('path');

const ruPath = path.join(__dirname, '../src/locales/ru.json');
const enPath = path.join(__dirname, '../src/locales/en.json');

const ruData = JSON.parse(fs.readFileSync(ruPath, 'utf-8'));
const enData = JSON.parse(fs.readFileSync(enPath, 'utf-8'));

const updates = {
  seller_btn_cabinet: { ru: "🏪 Кабинет", en: "🏪 Cabinet" }
};

for (const [key, trans] of Object.entries(updates)) {
  ruData[key] = trans.ru;
  enData[key] = trans.en;
}

fs.writeFileSync(ruPath, JSON.stringify(ruData, null, 2), 'utf-8');
fs.writeFileSync(enPath, JSON.stringify(enData, null, 2), 'utf-8');

console.log('Cabinet locale updated successfully!');
