declare module "qrcode-terminal" {
  const qrcode: {
    generate: (input: string, opts?: { small?: boolean }, cb?: () => void) => void;
  };
  export default qrcode;
}
