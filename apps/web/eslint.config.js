import reactHooks from 'eslint-plugin-react-hooks';
import rootConfig from '../../eslint.config.js';

// eslint-plugin-react-hooks는 apps/web에만 설치하므로 화면 코드의 React 규칙은 이 파일에서 덧붙입니다.
export default [...rootConfig, reactHooks.configs.flat.recommended];
