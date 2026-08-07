import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (!password) {
  console.error('Kullanım: npm run hash-password -- "sifreniz"');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
console.log(hash);
