// words.ts — the session-id vocabulary and minting. `open` names each session
// with a short, memorable two-word slug (e.g. `brave-otter`) rather than a GUID:
// it's easy to read back, token-efficient for the agent to pass to every `poll`,
// and — drawn from these ~200x~200 lists — effectively unique among the handful
// of sessions a single user runs at once. Only concurrently *live* sessions can
// clash, and `open` re-draws on that rare case (see `mintFreshSessionId` in
// cli.ts), so minting itself stays a pure random pick with no collision check.

const ADJECTIVES = [
  'able', 'agile', 'amber', 'ample', 'ancient', 'arctic', 'ashen', 'autumn',
  'azure', 'balmy', 'bold', 'brave', 'brief', 'bright', 'brisk', 'bronze',
  'calm', 'candid', 'cheery', 'chill', 'civic', 'clear', 'clever', 'cloudy',
  'coastal', 'cobalt', 'cool', 'cosmic', 'cozy', 'crisp', 'curly', 'daring',
  'dawn', 'deep', 'dewy', 'dim', 'dizzy', 'dry', 'dual', 'dusky', 'eager',
  'early', 'earthy', 'easy', 'elder', 'electric', 'ember', 'fabled', 'faded',
  'fair', 'fancy', 'fast', 'fearless', 'feisty', 'fern', 'fiery', 'fine',
  'firm', 'flint', 'fluffy', 'fond', 'frank', 'free', 'fresh', 'frosty',
  'gentle', 'giddy', 'gilded', 'glad', 'gleaming', 'golden', 'grand', 'grassy',
  'gray', 'green', 'happy', 'hardy', 'hazel', 'hazy', 'hearty', 'hidden',
  'hollow', 'humble', 'icy', 'idle', 'indigo', 'inky', 'iron', 'ivory',
  'jade', 'jaunty', 'jolly', 'jovial', 'keen', 'kind', 'lanky', 'late',
  'lazy', 'leafy', 'lively', 'lofty', 'lone', 'loyal', 'lucid', 'lucky',
  'lunar', 'lush', 'mellow', 'merry', 'mild', 'minty', 'misty', 'modest',
  'mossy', 'muted', 'nifty', 'nimble', 'noble', 'north', 'olive', 'opal',
  'pale', 'peppy', 'pine', 'placid', 'plain', 'plucky', 'plum', 'polar',
  'prim', 'proud', 'pure', 'quaint', 'quick', 'quiet', 'rapid', 'rare',
  'ready', 'regal', 'ripe', 'robust', 'rocky', 'rosy', 'rough', 'round',
  'royal', 'ruby', 'rugged', 'rustic', 'sage', 'sandy', 'scarlet', 'shady',
  'sharp', 'sheer', 'shiny', 'silent', 'silken', 'silver', 'simple', 'sleek',
  'slate', 'small', 'smart', 'smoky', 'smooth', 'snappy', 'snowy', 'soft',
  'solar', 'solid', 'sonic', 'sparse', 'spry', 'stark', 'steady', 'steely',
  'stellar', 'stern', 'still', 'stony', 'stout', 'sturdy', 'sunny', 'supple',
  'swift', 'tame', 'tawny', 'teal', 'tender', 'terse', 'tidal', 'tidy',
  'timely', 'tiny', 'topaz', 'tranquil', 'trim', 'trusty', 'twilit', 'umber',
  'upbeat', 'urban', 'valiant', 'velvet', 'verdant', 'vernal', 'vivid', 'warm',
  'wary', 'watery', 'whimsical', 'wild', 'windy', 'winter', 'wise', 'witty',
  'woven', 'young', 'zany', 'zesty',
] as const;

const ANIMALS = [
  'adder', 'akita', 'alpaca', 'antelope', 'auk', 'badger', 'barb', 'bass',
  'beagle', 'bear', 'beaver', 'bee', 'beetle', 'bison', 'boa', 'bobcat',
  'bonobo', 'buck', 'buffalo', 'bulldog', 'bunny', 'camel', 'caribou', 'carp',
  'cat', 'caterpillar', 'chamois', 'cheetah', 'chinchilla', 'chipmunk', 'cicada', 'civet',
  'cobra', 'colt', 'condor', 'cougar', 'coyote', 'crane', 'cricket', 'crow',
  'cuckoo', 'curlew', 'deer', 'dingo', 'dodo', 'dolphin', 'donkey', 'dormouse',
  'dove', 'dragonfly', 'drake', 'duck', 'eagle', 'egret', 'eider', 'elk',
  'emu', 'ermine', 'falcon', 'fawn', 'ferret', 'finch', 'firefly', 'fisher',
  'flamingo', 'fossa', 'fox', 'frog', 'gannet', 'gazelle', 'gecko', 'gerbil',
  'gibbon', 'giraffe', 'gnu', 'goat', 'goose', 'gopher', 'grackle', 'grouse',
  'guppy', 'hamster', 'hare', 'harrier', 'hawk', 'hedgehog', 'heron', 'hippo',
  'hornet', 'horse', 'hound', 'ibex', 'ibis', 'iguana', 'impala', 'jackal',
  'jaguar', 'jay', 'jerboa', 'kingfisher', 'kite', 'kiwi', 'koala', 'kudu',
  'ladybug', 'lark', 'lemur', 'leopard', 'lion', 'lizard', 'llama', 'lobster',
  'locust', 'loon', 'lynx', 'macaw', 'magpie', 'mallard', 'mamba', 'manatee',
  'mantis', 'marlin', 'marmot', 'marten', 'meerkat', 'mink', 'mole', 'mongoose',
  'moose', 'moth', 'mouse', 'mule', 'muskox', 'narwhal', 'newt', 'ocelot',
  'octopus', 'okapi', 'opossum', 'oriole', 'osprey', 'otter', 'owl', 'ox',
  'panther', 'parrot', 'partridge', 'peacock', 'pelican', 'penguin', 'perch', 'petrel',
  'pheasant', 'pigeon', 'pika', 'pony', 'porcupine', 'possum', 'puffin', 'puma',
  'quail', 'quokka', 'rabbit', 'raccoon', 'ram', 'raven', 'ray', 'reindeer',
  'rhino', 'roan', 'robin', 'rook', 'salmon', 'seal', 'serval', 'shark',
  'sheep', 'shrew', 'shrike', 'skink', 'skunk', 'sloth', 'snail', 'snake',
  'snipe', 'sparrow', 'spider', 'squid', 'squirrel', 'starling', 'stag', 'stoat',
  'stork', 'swan', 'swift', 'tapir', 'teal', 'tern', 'thrush', 'tiger',
  'toad', 'tortoise', 'toucan', 'trout', 'turtle', 'urchin', 'viper', 'vole',
  'walrus', 'warbler', 'wasp', 'weasel', 'whale', 'wolf', 'wombat', 'woodpecker',
  'wren', 'yak', 'zebra', 'zebu',
] as const;

// Pick a uniform random element (Math.random is fine — session ids are memorable
// handles, not secrets, and the loopback bind is the actual guard).
function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

// Mint a fresh two-word session id, e.g. `brave-otter`.
export function mintSessionId(): string {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
}

// Exposed for the combination-count test (the no-collision-check argument rests
// on the list sizes staying large).
export const WORD_LIST_SIZES = { adjectives: ADJECTIVES.length, animals: ANIMALS.length };
