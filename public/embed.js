// Врезки постов из Instagram: до клика читателя на странице нет ни одного
// запроса к Meta — только наша карточка. По клику она заменяется официальным
// iframe instagram.com/p/CODE/embed.
//
// Скрипт — усиление, а не условие: без него карточка остаётся обычной ссылкой
// на пост, поэтому обработчик и висит на click, а не подменяет разметку сразу.
(function () {
  'use strict';

  var ORIGIN = 'https://www.instagram.com';
  var frames = [];

  function embed(card) {
    var src = card.getAttribute('data-embed-src');
    if (!src || src.indexOf(ORIGIN + '/') !== 0) return;

    var frame = document.createElement('iframe');
    frame.className = 'ig-embed-frame';
    frame.src = src;
    frame.title = 'Пост из Instagram';
    frame.loading = 'lazy';
    frame.scrolling = 'no';
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('allowtransparency', 'true');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    // allow-same-origin нужен самой врезке (её скрипты и хранилище), а вот
    // уводить нашу вкладку и слать формы ей незачем.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.style.height = '640px'; // до первого MEASURE

    card.parentNode.replaceChild(frame, card);
    frames.push(frame);
  }

  document.addEventListener('click', function (e) {
    var card = e.target.closest && e.target.closest('.ig-embed-card');
    if (!card) return;
    e.preventDefault();
    embed(card);
  });

  // Врезка сама сообщает свою высоту сообщением MEASURE — иначе под коротким
  // постом оставалась бы пустая полоса, а длинный обрезался бы.
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;
    var data = e.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (err) {
        return;
      }
    }
    if (!data || data.type !== 'MEASURE' || !data.details) return;

    var height = parseInt(data.details.height, 10);
    if (!height || height < 100 || height > 4000) return;

    for (var i = 0; i < frames.length; i += 1) {
      if (frames[i].contentWindow === e.source) frames[i].style.height = height + 'px';
    }
  });
})();
