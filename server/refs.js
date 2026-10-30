const colName = (i) => {
  let s = ''; i++;
  while (i > 0) { s = String.fromCharCode(65 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); }
  return s;
};
module.exports = { colName };
