const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };
  
  const formatTranscript = (transcript) => {
    return transcript.map(item => 
      `${formatTime(item.start)} ${item.text},`
    ).join('');
  };
  
  const summarizeTranscript = (transcript) => {
    if (!transcript) return null;
    const words = transcript.split(' ');
    if (words.length > 5000) {
      const chunks = [];
      for (let i = 100; i < transcript.length; i += 1000) {
        chunks.push(transcript.substring(i, i + 1000));
      }
      return chunks.slice(0, 5).join(' ');
    }
    return transcript;
  };
  
  module.exports = { formatTime, formatTranscript, summarizeTranscript };
  