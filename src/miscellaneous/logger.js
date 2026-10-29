const chalk = require('chalk')

module.exports = {
  startup: (...info) => console.log(chalk`${new Date().toUTCString()} {bold.whiteBright.bgBlue STARTUP} `, ...info),
  fatal: (...info) => {
    console.log(chalk`${new Date().toUTCString()} {bold.white.bgRed FATAL}: `, ...info)
    process.exit()
  },
  error: (...info) => {
    console.log(chalk`${new Date().toUTCString()} {bold.red ERROR}: `, ...info)
  },
  warn: (...info) => console.log(chalk`${new Date().toUTCString()} {bold.yellow WARN}: `, ...info),
  info: (...info) => console.log(chalk`${new Date().toUTCString()} {bold.blue INFO}: `, ...info.map(m => chalk`{white ${m}}`)),
  debug: (...info) => console.log(chalk`${new Date().toUTCString()} {bgGreen DEBUG}: `, ...info.map(m => chalk`{black.bgWhite ${m}}`))
}
