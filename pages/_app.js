import "@/styles/globals.css";

export default function App({ Component, pageProps }) {
  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900">
      <Component {...pageProps} />
    </div>
  );
}
