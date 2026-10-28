export default {
  description: 'Popple is an anti-stress game. Just pop some bubbles.',
  restart: 'Popple, start over', controls: 'Film settings', themeTitle: 'Switch theme',
  lightTheme: 'Turn on light theme', darkTheme: 'Turn on dark theme', soundTitle: 'Sound',
  soundOff: 'Turn off sound', soundOn: 'Turn on sound', settingsTitle: 'Settings',
  settingsOpen: 'Customize your experience', heading: 'Just pop', more: 'more', moreLabel: 'More bubble wrap',
  playground: 'Bubble wrap', renderError: 'Could not start graphics. Try opening this page in Safari or Chrome.',
  settingsHeading: 'Make it yours', close: 'Close settings', settingsDescription: 'Make the bubble wrap feel just right.',
  language: 'Language', size: 'Bubble size', defaultSize: '≈ 2 cm',
  sizeDescription: 'Sizes vary between screens — adjust to fit your finger.',
  hold: 'Time to pop', holdDescription: 'How long to hold a bubble. Default: 0.3 s.',
  tilt: 'Highlights on tilt', tiltDescription: 'Highlights move slightly when you tilt or turn your phone.',
  permission: 'Allow access', motion: 'Fewer effects', footer: 'Settings save automatically.',
  bubbleRefilling: n => `Bubble ${n} is inflating`, bubblePopped: n => `Bubble ${n} popped. You can crumple the film`,
  bubbleReady: n => `Bubble ${n}. Hold to pop`, popped: (n,total) => `Pop! ${n} of ${total} bubbles popped.`,
  ready: 'The film is ready. You can pop bubbles.', refilling: 'Bubbles are inflating.',
  newFilm: n => `New film. ${n} bubbles.`, seconds: n => `${n} s`, secondsLabel: n => `${n} seconds`,
  tiltStatus: {idle:'',pending:'Waiting for motion access.',listening:'Tilt your phone slightly to move the highlights.',granted:'Highlights follow your phone’s movement.',denied:'Motion access is blocked. You can allow it in your browser settings.',unavailable:'Tilt is unavailable on this device.',insecure:'Open this page over HTTPS to use tilt.','no-data':'The sensor is not sending motion data yet. Try tilting your phone.','permission-required':'Tilt is enabled. Allow the browser to access motion.',reduced:'Tilt is paused while fewer effects are enabled.',suspended:''}
};
