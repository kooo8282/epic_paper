async function test() {
  try {
    const res = await fetch('https://scholar.pusan.ac.kr/journals/13903');
    console.log('Status:', res.status, res.url);
    const text = await res.text();
    require('fs').writeFileSync('pnu_html.txt', text);
    console.log('Saved to pnu_html.txt');
  } catch (e) {
    console.error(e);
  }
}
test();
