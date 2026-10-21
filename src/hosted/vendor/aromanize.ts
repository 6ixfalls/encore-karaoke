// Aromanize-js, Fajar Chandra (2017). Revised Romanization rules and
// contextual Hangul conversion retained from Encore upstream's bundled copy.
// TypeScript port removes unused transliteration modes, CLI and prototype patches.
interface Rule { cho: Record<string, string>; cho2?: Record<string, string>; jung: Record<string, string>; jong: Record<string, string>; hyphen?: string }
const rulemap: Rule = {
				// Note: giyeok (0x1100) for middle moeum is different than giyeok (0x3131) for standalone jamo
				cho: {
					'ᄀ': 'g', 'ᄁ': 'kk',
					'ᄂ': 'n',
					'ᄃ': 'd', 'ᄄ': 'tt',
					'ᄅ': 'r', 
					'ᄆ': 'm',
					'ᄇ': 'b', 'ᄈ': 'pp',
					'ᄉ': 's', 'ᄊ': 'ss',
					'ᄋ': '',
					'ᄌ': 'j', 'ᄍ': 'jj',
					'ᄎ': 'ch', 
					'ᄏ': 'k', 
					'ᄐ': 't',
					'ᄑ': 'p',
					'ᄒ': 'h'
				},
				
				// Note: ᅡ (0x1161) for middle moeum is different than ㅏ (0x314F) for standalone jamo
				jung: {
					'ᅡ': 'a', 'ᅢ': 'ae', 'ᅣ': 'ya', 'ᅤ': 'yae', 
					'ᅥ': 'eo', 'ᅦ': 'e', 'ᅧ': 'yeo', 'ᅨ': 'ye', 
					'ᅩ': 'o', 'ᅪ': 'wa', 'ᅫ': 'wae', 'ᅬ': 'oe', 'ᅭ': 'yo',
					'ᅮ': 'u', 'ᅯ': 'wo', 'ᅰ': 'we', 'ᅱ': 'wi', 'ᅲ': 'yu', 
					'ᅳ': 'eu', 'ᅴ': 'eui', 'ᅵ': 'i'
				},
				
				// Note: ᆨ (0x11A8) for last jaeum (batchim) is different than ᄀ (0x1100) for first jaeum
				// also different than ㄱ (0x3131) for standalone jamo
				jong: {
					'ᆨ': 'k', 'ᆨᄋ': 'g', 'ᆨᄂ': 'ngn', 'ᆨᄅ': 'ngn', 'ᆨᄆ': 'ngm', 'ᆨᄒ': 'kh',
					'ᆩ': 'kk', 'ᆩᄋ': 'kg', 'ᆩᄂ': 'ngn', 'ᆩᄅ': 'ngn', 'ᆩᄆ': 'ngm', 'ᆩᄒ': 'kh',
					'ᆪ': 'k', 'ᆪᄋ': 'ks', 'ᆪᄂ': 'ngn', 'ᆪᄅ': 'ngn', 'ᆪᄆ': 'ngm', 'ᆪᄒ': 'kch', 
					'ᆫ': 'n', 'ᆫᄅ': 'll', 
					'ᆬ': 'n', 'ᆬᄋ': 'nj', 'ᆬᄂ': 'nn', 'ᆬᄅ': 'nn', 'ᆬᄆ': 'nm', 'ᆬㅎ': 'nch',
					'ᆭ': 'n', 'ᆭᄋ': 'nh', 'ᆭᄅ': 'nn', 
					'ᆮ': 't', 'ᆮᄋ': 'd', 'ᆮᄂ': 'nn', 'ᆮᄅ': 'nn', 'ᆮᄆ': 'nm', 'ᆮᄒ': 'th', 
					'ᆯ': 'l', 'ᆯᄋ': 'r', 'ᆯᄂ': 'll', 'ᆯᄅ': 'll', 
					'ᆰ': 'k', 'ᆰᄋ': 'lg', 'ᆰᄂ': 'ngn', 'ᆰᄅ': 'ngn', 'ᆰᄆ': 'ngm', 'ᆰᄒ': 'lkh',
					'ᆱ': 'm', 'ᆱᄋ': 'lm', 'ᆱᄂ': 'mn', 'ᆱᄅ': 'mn', 'ᆱᄆ': 'mm', 'ᆱᄒ': 'lmh', 
					'ᆲ': 'p', 'ᆲᄋ': 'lb', 'ᆲᄂ': 'mn', 'ᆲᄅ': 'mn', 'ᆲᄆ': 'mm', 'ᆲᄒ': 'lph', 
					'ᆳ': 't', 'ᆳᄋ': 'ls', 'ᆳᄂ': 'nn', 'ᆳᄅ': 'nn', 'ᆳᄆ': 'nm', 'ᆳᄒ': 'lsh', 
					'ᆴ': 't', 'ᆴᄋ': 'lt', 'ᆴᄂ': 'nn', 'ᆴᄅ': 'nn', 'ᆴᄆ': 'nm', 'ᆴᄒ': 'lth', 
					'ᆵ': 'p', 'ᆵᄋ': 'lp', 'ᆵᄂ': 'mn', 'ᆵᄅ': 'mn', 'ᆵᄆ': 'mm', 'ᆵᄒ': 'lph', 
					'ᆶ': 'l', 'ᆶᄋ': 'lh', 'ᆶᄂ': 'll', 'ᆶᄅ': 'll', 'ᆶᄆ': 'lm', 'ᆶᄒ': 'lh',
					'ᆷ': 'm', 'ᆷᄅ': 'mn', 
					'ᆸ': 'p', 'ᆸᄋ': 'b', 'ᆸᄂ': 'mn', 'ᆸᄅ': 'mn', 'ᆸᄆ': 'mm', 'ᆸᄒ': 'ph', 
					'ᆹ': 'p', 'ᆹᄋ': 'ps', 'ᆹᄂ': 'mn', 'ᆹᄅ': 'mn', 'ᆹᄆ': 'mm', 'ᆹᄒ': 'psh', 
					'ᆺ': 't', 'ᆺᄋ': 's', 'ᆺᄂ': 'nn', 'ᆺᄅ': 'nn', 'ᆺᄆ': 'nm', 'ᆺᄒ': 'sh', 
					'ᆻ': 't', 'ᆻᄋ': 'ss', 'ᆻᄂ': 'tn', 'ᆻᄅ': 'tn', 'ᆻᄆ': 'nm', 'ᆻᄒ': 'th', 
					'ᆼ': 'ng',
					'ᆽ': 't', 'ᆽᄋ': 'j', 'ᆽᄂ': 'nn', 'ᆽᄅ': 'nn', 'ᆽᄆ': 'nm', 'ᆽᄒ': 'ch', 
					'ᆾ': 't', 'ᆾᄋ': 'ch', 'ᆾᄂ': 'nn', 'ᆾᄅ': 'nn', 'ᆾᄆ': 'nm', 'ᆾᄒ': 'ch', 
					'ᆿ': 'k', 'ᆿᄋ': 'k', 'ᆿᄂ': 'ngn', 'ᆿᄅ': 'ngn', 'ᆿᄆ': 'ngm', 'ᆿᄒ': 'kh', 
					'ᇀ': 't', 'ᇀᄋ': 't', 'ᇀᄂ': 'nn', 'ᇀᄅ': 'nn', 'ᇀᄆ': 'nm', 'ᇀᄒ': 'th', 
					'ᇁ': 'p', 'ᇁᄋ': 'p', 'ᇁᄂ': 'mn', 'ᇁᄅ': 'mn', 'ᇁᄆ': 'mm', 'ᇁᄒ': 'ph', 
					'ᇂ': 't', 'ᇂᄋ': 'h', 'ᇂᄂ': 'nn', 'ᇂᄅ': 'nn', 'ᇂᄆ': 'mm', 'ᇂᄒ': 't',
					'ᇂᄀ': 'k', 
				}
			};
export function romanize(text: string): string {
  const args = { text, hyphen: "" };
  const isChoseong = (char: string) => char.charCodeAt(0) >= 0x1100 && char.charCodeAt(0) <= 0x1112;
		var rom = '';
		let curr: string | null = null, next: string;
		var skipJaeum = false; // Indicates jaeum of current iteration to be skipped
		for(var i = 0; i <= args.text.length; i++) {
			// If next is hangul syllable, separate it into jamo
			// 0xAC00 is the first hangul syllable in unicode table
			// 0x1100 is the first hangul jaeum in unicode table
			// 0x1161 is the first hangul moeum in unicode table
			// 0x11A8 is the first hangul batchim in unicode table
			const nextIdx = args.text.charCodeAt(i) - 0xAC00;
			if(!isNaN(nextIdx) && nextIdx >= 0 && nextIdx <= 11171) {
				next = String.fromCharCode(Math.floor(nextIdx / 588) + 0x1100)
					+ String.fromCharCode(Math.floor(nextIdx % 588 / 28) + 0x1161)
					+ (nextIdx % 28 == 0 ? '' : String.fromCharCode(nextIdx % 28 + 0x11A7)); // Index 0 is reserved for nothing
			}
			else {
				next = args.text.charAt(i);
			}
			
			// Except for first iteration (curr is null), 
			// Curr and next contains 2 or 3 jamo, or 1 non-hangul letter
			if(curr != null) {
				
				var res = '';
				
				// Choseong Jaeum
				if(!skipJaeum) {
					// If not the first syllable, try cho2 if defined
					if(i > 0 && !/\s/.test(args.text.charAt(i-2)) && 
					   rulemap.cho2 != undefined &&
					   rulemap.cho2[curr.charAt(0)] != undefined
					) {
						res += rulemap.cho2[curr.charAt(0)];
					}
					else if(rulemap.cho[curr.charAt(0)] != undefined) {
						res += rulemap.cho[curr.charAt(0)];
					}
					else {
						res += curr.charAt(0);
					}
				}
				skipJaeum = false;
				
				// Jungseong Moeum
				if(curr.length > 1) {
					if(rulemap.jung[curr.charAt(1)] != undefined) {
						res += rulemap.jung[curr.charAt(1)];
					}
					else {
						res += curr.charAt(1);
					}
					
					// Add hyphen if no batchim
					if(curr.length == 2 && isChoseong(next.charAt(0))) {
						res += ' ';
					}
				}
				
				// Jongseong Jaeum (Batchim)
				if(curr.length > 2) {
					// Changing sound with next jaeum + moeum
					if(rulemap.jong[curr.charAt(2) + next.charAt(0) + next.charAt(1)] != undefined) {
						res += rulemap.jong[curr.charAt(2) + next.charAt(0) + next.charAt(1)];
						skipJaeum = true;
						
						// No need to add hyphen here as it's already defined
					}
					// Changing sound with next jaeum
					else if(rulemap.jong[curr.charAt(2) + next.charAt(0)] != undefined) {
						res += rulemap.jong[curr.charAt(2) + next.charAt(0)];
						skipJaeum = true;
						
						// No need to add hyphen here as it's already defined
					}
					// Unchanging sound
					else if(rulemap.jong[curr.charAt(2)] != undefined) {
						res += rulemap.jong[curr.charAt(2)];
						
						// Add hyphen
						if(isChoseong(next.charAt(0))) {
							res += ' ';
						}
					}
					else {
						res += curr.charAt(2);
						
						// Add hyphen
						if(isChoseong(next.charAt(0))) {
							res += ' ';
						}
					}
				}
				
				// Replace hyphen (if this is hangeul word)
				if(curr.length > 1) {
					if(args.hyphen == '' && rulemap.hyphen != null) {
						res = res.replace(' ', rulemap.hyphen);
					}
					else {
						// Soft hyphen
						res = res.replace(' ', args.hyphen);
						// Hard hyphen
						if(args.hyphen != '') {
							res = res.replace('-', args.hyphen);
						}
					}
				}
				rom += res;
			}
			
			curr = next;
		}
		return rom;
}
export default { romanize };
